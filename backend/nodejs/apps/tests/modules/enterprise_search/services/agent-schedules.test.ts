import { strict as assert } from 'node:assert';
import { AgentSchedules, AgentScheduleInput, nextAgentRun } from '../../../../src/modules/enterprise_search/services/agent-schedules';
import { requirePublicResearchAgent, withoutSlackMentions } from '../../../../src/modules/enterprise_search/services/scheduled-agent-runtime';

class MemoryStore {
  values = new Map<string, string>();
  async get<T>(key: string): Promise<T | null> { return (this.values.get(key) ?? null) as T | null; }
  async compareAndSet(key: string, expected: string | null, value: string): Promise<boolean> {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, value); return true;
  }
  async listKeysInDirectory(prefix: string): Promise<string[]> { return [...this.values.keys()].filter(key => key.startsWith(prefix)); }
}
const input: AgentScheduleInput = { enabled: true, days: [1, 3, 5], hour: 9, minute: 0, timezone: 'Europe/Rome', prompt: 'Public AI brief' };
const result = { conversationId: 'a'.repeat(24), links: ['https://example.org/news'], needsReview: true };

describe('Native agent schedules', () => {
  it('keeps 09:00 local time through daylight saving', () => {
    assert.equal(nextAgentRun(input, Date.parse('2026-11-09T07:59:00Z')), Date.parse('2026-11-09T08:00:00Z'));
    assert.equal(nextAgentRun(input, Date.parse('2026-07-06T06:59:00Z')), Date.parse('2026-07-06T07:00:00Z'));
    assert.throws(() => nextAgentRun({ ...input, timezone: 'Not/AZone' }, Date.now()));
  });
  it('claims a due run once across two replicas and survives a new service instance', async () => {
    const store = new MemoryStore(); let now = Date.parse('2026-11-09T07:59:00Z'); let executions = 0;
    const execute = async () => { executions++; return result; };
    const first = new AgentSchedules(store, execute, () => {}, () => now);
    const second = new AgentSchedules(store, execute, () => {}, () => now);
    await first.save('org', 'owner', 'agent', input);
    now += 60_000;
    await Promise.all([first.tick(), second.tick()]);
    assert.equal(executions, 1);
    const saved = await second.read('org', 'owner', 'agent');
    assert.equal(saved?.runs[0].status, 'needs_review');
    assert.equal(saved?.runs[0].conversationId, result.conversationId);
    assert.ok(saved!.nextRunAt! > now);
    await new AgentSchedules(store, execute, () => {}, () => now).tick();
    assert.equal(executions, 1);
  });
  it('separates organization and owner schedules and refuses stale edits', async () => {
    const service = new AgentSchedules(new MemoryStore(), async () => result, () => {});
    await service.save('org-a', 'owner', 'agent', input);
    assert.equal(await service.read('org-b', 'owner', 'agent'), null);
    assert.equal(await service.read('org-a', 'other-owner', 'agent'), null);
    await assert.rejects(service.save('org-a', 'owner', 'agent', input));
  });
  it('persists a conversation before model work and pauses after an uncertain outcome', async () => {
    const store = new MemoryStore(); let now = Date.parse('2026-11-09T07:59:00Z'); let attempts = 0;
    const service = new AgentSchedules(store, async (_schedule, _run, record) => {
      attempts++; await record(result.conversationId); throw new Error('timeout');
    }, () => {}, () => now);
    await service.save('org', 'owner', 'agent', input); now += 60_000;
    await service.tick(); await service.tick();
    const saved = await service.read('org', 'owner', 'agent');
    assert.equal(attempts, 1); assert.equal(saved?.enabled, false);
    assert.equal(saved?.runs[0].status, 'needs_reconciliation');
    assert.equal(saved?.runs[0].conversationId, result.conversationId);
  });
  it('preserves a pause saved while a run is in flight', async () => {
    let release!: () => void; let signal!: () => void;
    const started = new Promise<void>(resolve => { signal = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const service = new AgentSchedules(new MemoryStore(), async () => { signal(); await wait; return result; }, () => {});
    await service.save('org', 'owner', 'agent', { ...input, enabled: false });
    const running = service.runNow('org', 'owner', 'agent'); await started;
    const active = await service.read('org', 'owner', 'agent');
    await service.save('org', 'owner', 'agent', { ...input, enabled: false, revision: active!.revision });
    let drained = false;
    const stopping = service.stop().then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    release(); await running; await stopping; assert.equal(drained, true);
    const saved = await service.read('org', 'owner', 'agent');
    assert.equal(saved?.enabled, false); assert.equal(saved?.nextRunAt, null);
    assert.equal(saved?.runs[0].status, 'needs_review');
  });
  it('marks a crashed run for reconciliation without executing it again', async () => {
    const store = new MemoryStore(); let now = Date.parse('2026-11-09T07:59:00Z');
    const original = new AgentSchedules(store, async () => result, () => {}, () => now);
    await original.save('org', 'owner', 'agent', input);
    const key = [...store.values.keys()][0]; const saved = JSON.parse(store.values.get(key)!);
    saved.runs = [{ id: 'crashed', startedAt: now - 16 * 60_000, status: 'running', periodStart: now - 86400_000, periodEnd: now }];
    store.values.set(key, JSON.stringify(saved)); let calls = 0;
    await new AgentSchedules(store, async () => { calls++; return result; }, () => {}, () => now).tick();
    assert.equal(calls, 0);
    assert.equal((await original.read('org', 'owner', 'agent'))?.runs[0].status, 'needs_reconciliation');
  });
  it('refuses unattended action, company-data and service agents', () => {
    const publicAgent = { skills: [], knowledge: [], toolsets: [], mcpServers: [], apiToolsetTools: [], isActive: true, sendUserContext: false, isServiceAccount: false };
    assert.doesNotThrow(() => requirePublicResearchAgent(publicAgent));
    for (const field of ['knowledge', 'toolsets', 'mcpServers', 'apiToolsetTools', 'skills']) {
      assert.throws(() => requirePublicResearchAgent({ ...publicAgent, [field]: ['private'] }));
    }
    assert.throws(() => requirePublicResearchAgent({ ...publicAgent, isServiceAccount: true }));
    assert.throws(() => requirePublicResearchAgent({ ...publicAgent, sendUserContext: true }));
    assert.throws(() => requirePublicResearchAgent({ ...publicAgent, isActive: false }));
    assert.throws(() => requirePublicResearchAgent({ ...publicAgent, mcpServersUnavailable: true }));
  });
  it('waits for query readiness without claiming or pausing an overdue run', async () => {
    const store = new MemoryStore(); let now = Date.parse('2026-11-09T07:59:00Z'); let ready = false; let calls = 0;
    const service = new AgentSchedules(store, async () => { calls++; return result; }, () => {}, () => now, async () => ready);
    await service.save('org', 'owner', 'agent', input); now += 60_000;
    await service.tick();
    assert.equal(calls, 0); assert.equal((await service.read('org', 'owner', 'agent'))?.enabled, true);
    ready = true; await service.tick(); assert.equal(calls, 1);
  });
  it('renders source links while preventing model content from pinging Slack users or channels', () => {
    const safe = withoutSlackMentions('Hello <@U12345678> <!here> <!channel> <#C12345678> <https://example.com|Source>');
    assert.equal(withoutSlackMentions('<<!here>>'), '&lt;&lt;!here>>');
    assert.equal(safe, 'Hello &lt;@U12345678> &lt;!here> &lt;!channel> &lt;#C12345678> <https://example.com|Source>');
  });

});
