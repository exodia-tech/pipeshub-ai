import { randomUUID } from 'node:crypto';
import { getNextMillis } from 'bullmq';
import { KeyValueStoreService } from '../../../libs/services/keyValueStore.service';
import { BadRequestError, ConflictError } from '../../../libs/errors/http.errors';
import { spawnDetached } from '../../../libs/context/orgContext';

export interface AgentScheduleInput {
  enabled: boolean;
  days: number[];
  hour: number;
  minute: number;
  timezone: string;
  prompt: string;
  revision?: number;
  slackBotId?: string | null;
  slackChannelId?: string | null;
  projectId?: string | null;
  projectGrantId?: string | null;
}
export interface ScheduledAgentRun {
  id: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'draft' | 'needs_review' | 'needs_reconciliation';
  conversationId?: string;
  slackTs?: string;
  periodStart: number;
  periodEnd: number;
}
export interface AgentSchedule extends AgentScheduleInput {
  orgId: string;
  userId: string;
  agentId: string;
  revision: number;
  nextRunAt: number | null;
  lastSuccessfulEnd?: number;
  coveredLinks: string[];
  runs: ScheduledAgentRun[];
}
export interface AgentRunResult {
  conversationId: string;
  links: string[];
  needsReview: boolean;
  slackTs?: string;
}
type Store = Pick<KeyValueStoreService, 'get' | 'compareAndSet' | 'listKeysInDirectory'>;
const PREFIX = '/agent-schedules/';
const MAX_RUN_MS = 15 * 60_000;
const scheduleKey = (orgId: string, userId: string, agentId: string): string =>
  `${PREFIX}${orgId}/${userId}/${agentId}`;

export function nextAgentRun(input: AgentScheduleInput, now: number): number {
  new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(now);
  const next = getNextMillis(now, {
    pattern: `${input.minute} ${input.hour} * * ${input.days.join(',')}`,
    tz: input.timezone,
  });
  if (!next || next <= now) throw new BadRequestError('Invalid agent schedule');
  return next;
}

/** One public-research schedule per creator/agent; no credentials or model content in the ledger. */
export class AgentSchedules {
  private timer: NodeJS.Timeout | undefined;
  private pass: Promise<void> | undefined;
  private stopping = false;
  private readonly manualRuns = new Set<Promise<void>>();
  constructor(
    private readonly store: Store,
    private readonly execute: (schedule: AgentSchedule, run: ScheduledAgentRun, recordConversation: (id: string) => Promise<void>) => Promise<AgentRunResult>,
    private readonly reportError: () => void,
    private readonly clock: () => number = Date.now,
    private readonly ready: () => Promise<boolean> = async () => true,
  ) {}

  async read(orgId: string, userId: string, agentId: string): Promise<AgentSchedule | null> {
    const raw = await this.store.get<string>(scheduleKey(orgId, userId, agentId));
    return raw ? JSON.parse(raw) as AgentSchedule : null;
  }

  async saveSchedule(orgId: string, userId: string, agentId: string, input: AgentScheduleInput): Promise<AgentSchedule> {
    const key = scheduleKey(orgId, userId, agentId);
    const raw = await this.store.get<string>(key);
    const previous = raw ? JSON.parse(raw) as AgentSchedule : null;
    if ((previous?.revision ?? 0) !== (input.revision ?? 0)) {
      throw new ConflictError('The schedule changed. Reload it before saving.');
    }
    const next: AgentSchedule = {
      ...input, orgId, userId, agentId,
      revision: (previous?.revision ?? 0) + 1,
      nextRunAt: input.enabled ? nextAgentRun(input, this.clock()) : null,
      coveredLinks: previous?.coveredLinks ?? [],
      runs: previous?.runs ?? [],
      ...(previous?.lastSuccessfulEnd ? { lastSuccessfulEnd: previous.lastSuccessfulEnd } : {}),
    };
    if (!await this.store.compareAndSet(key, raw, JSON.stringify(next))) {
      throw new ConflictError('The schedule changed. Reload it before saving.');
    }
    return next;
  }

  /** Claim before calling the model. An uncertain run is never automatically called a second time. */
  private async claim(key: string, force: boolean): Promise<{ schedule: AgentSchedule; run: ScheduledAgentRun } | null> {
    const raw = await this.store.get<string>(key);
    if (!raw || this.stopping) return null;
    const schedule = JSON.parse(raw) as AgentSchedule;
    if (key !== scheduleKey(schedule.orgId, schedule.userId, schedule.agentId)) return null;
    const now = this.clock();
    const active = schedule.runs.find(run => run.status === 'running');
    if (active) {
      if (now - active.startedAt > MAX_RUN_MS) {
        active.status = 'needs_reconciliation';
        active.finishedAt = now;
        schedule.enabled = false;
        schedule.nextRunAt = null;
        schedule.revision++;
        await this.store.compareAndSet(key, raw, JSON.stringify(schedule));
      }
      return null;
    }
    if (!force && (!schedule.enabled || !schedule.nextRunAt || schedule.nextRunAt > now)) return null;
    const run: ScheduledAgentRun = {
      id: randomUUID(), status: 'running', startedAt: now,
      periodStart: schedule.lastSuccessfulEnd ?? now - 7 * 86400_000,
      periodEnd: now,
    };
    schedule.runs = [run, ...schedule.runs].slice(0, 20);
    schedule.nextRunAt = schedule.enabled ? nextAgentRun(schedule, now) : null;
    schedule.revision++;
    return await this.store.compareAndSet(key, raw, JSON.stringify(schedule)) ? { schedule, run } : null;
  }

  private async finish(schedule: AgentSchedule, run: ScheduledAgentRun, result?: AgentRunResult): Promise<void> {
    const key = scheduleKey(schedule.orgId, schedule.userId, schedule.agentId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = await this.store.get<string>(key);
      if (!raw) throw new Error('Schedule disappeared during execution');
      const current = JSON.parse(raw) as AgentSchedule;
      const savedRun = current.runs.find(item => item.id === run.id);
      if (!savedRun) throw new Error('Run disappeared during execution');
      if (savedRun.status !== 'running') return;
      Object.assign(savedRun, {
        finishedAt: this.clock(),
        status: result ? (result.needsReview ? 'needs_review' : 'draft') : 'needs_reconciliation',
        ...(result ? { conversationId: result.conversationId } : {}),
        ...(result?.slackTs ? { slackTs: result.slackTs } : {}),
      });
      if (result) {
        current.lastSuccessfulEnd = run.periodEnd;
        current.coveredLinks = [...new Set([...current.coveredLinks, ...result.links])].slice(-100);
      } else {
        current.enabled = false;
        current.nextRunAt = null;
      }
      current.revision++;
      if (await this.store.compareAndSet(key, raw, JSON.stringify(current))) return;
    }
    throw new Error('Run result could not be persisted');
  }

  async runNow(orgId: string, userId: string, agentId: string): Promise<void> {
    const pending = (async () => {
      const claimed = await this.claim(scheduleKey(orgId, userId, agentId), true);
      if (!claimed) throw new ConflictError('No saved schedule, or a run is already active.');
      await this.perform(claimed);
    })();
    this.manualRuns.add(pending);
    try { await pending; } finally { this.manualRuns.delete(pending); }
  }

  private async perform({ schedule, run }: { schedule: AgentSchedule; run: ScheduledAgentRun }): Promise<void> {
    let result: AgentRunResult;
    try {
      result = await this.execute(schedule, run, async conversationId => {
        const key = scheduleKey(schedule.orgId, schedule.userId, schedule.agentId);
        for (let attempt = 0; attempt < 5; attempt++) {
          const raw = await this.store.get<string>(key);
          if (!raw) throw new Error('Schedule disappeared');
          const current = JSON.parse(raw) as AgentSchedule;
          const saved = current.runs.find(item => item.id === run.id);
          if (!saved || saved.status !== 'running') throw new Error('Run is no longer active');
          saved.conversationId = conversationId;
          current.revision++;
          if (await this.store.compareAndSet(key, raw, JSON.stringify(current))) return;
        }
        throw new Error('Conversation checkpoint could not be saved');
      });
    } catch {
      await this.finish(schedule, run);
      this.reportError();
      return;
    }
    await this.finish(schedule, run, result);
  }

  async tick(): Promise<void> {
    if (!await this.ready()) return;
    const keys = await this.store.listKeysInDirectory(PREFIX);
    for (const key of keys) {
      try {
        const claimed = await this.claim(key, false);
        if (claimed) await this.perform(claimed);
      } catch { this.reportError(); }
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    const tick = (): void => {
      if (this.pass) return;
      this.pass = this.tick().catch(this.reportError).finally(() => { this.pass = undefined; });
    };
    this.timer = spawnDetached(() => setInterval(tick, 60_000));
    this.timer.unref();
    spawnDetached(tick);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([this.pass, ...this.manualRuns]);
  }
}
