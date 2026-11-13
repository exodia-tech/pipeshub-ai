import { randomUUID } from 'crypto';
import axios from 'axios';
import {
  buildChatStreamUrl,
  resolveMentionsInText,
  NO_UNFURL_OPTIONS,
  type TypedSlackClient,
} from './helpers';
import type { SlackMessagePayload } from './helpers';

export function slackRunKey(
  message: SlackMessagePayload,
  botId?: string,
  teamId?: string,
): string | null {
  if (!botId || !message.channel || !message.user || !message.ts) return null;
  return JSON.stringify([
    teamId ?? '',
    botId,
    message.channel,
    message.thread_ts || message.ts,
    message.user,
  ]);
}

export class SlackActiveRun {
  readonly runId = randomUUID();
  readonly ready: Promise<string | null>;
  readonly done: Promise<void>;
  readonly started: Promise<boolean>;
  private resolveReady!: (id: string | null) => void;
  private resolveDone!: () => void;
  private resolveStarted!: (started: boolean) => void;

  constructor(
    readonly sourceTs: string,
    conversationId: string | null,
  ) {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
    if (conversationId) this.conversationCreated(conversationId);
  }

  conversationCreated(id: string): void {
    this.resolveReady(id);
  }
  runStarted(id: string): void {
    if (id === this.runId) this.resolveStarted(true);
  }
  finish(): void {
    this.resolveReady(null);
    this.resolveStarted(false);
    this.resolveDone();
  }
}

// shortcut: one bot process owns its streams; use shared routing before running bot replicas.
export const activeSlackRuns = new Map<string, SlackActiveRun>();

export async function trySteerSlackRun(
  run: SlackActiveRun,
  message: SlackMessagePayload,
  client: TypedSlackClient,
  accessToken: string,
  agentId: string | null,
): Promise<boolean> {
  if (run.sourceTs === message.ts) return true;
  if (message.files?.length) return false;
  if (!(await run.started)) return false;
  const conversationId = await run.ready;
  if (!conversationId) return false;
  const text = await resolveMentionsInText(message.text, client);
  if (!text.trim()) return false;
  let delivery: { queued?: boolean; duplicate?: boolean };
  try {
    delivery = (
      await axios.post(
        buildChatStreamUrl(conversationId, agentId).replace(
          /\/messages\/stream$/,
          '/steer',
        ),
        { runId: run.runId, text, messageId: message.ts },
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 30_000,
          maxRedirects: 0,
        },
      )
    ).data;
  } catch {
    throw new Error(
      "I couldn't deliver that update to the active run. Please try again.",
    );
  }
  if (!delivery.queued) return false;
  if (!delivery.duplicate && message.channel)
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.thread_ts || message.ts,
      text: "Got it - I'll use your update at the next step.",
      ...NO_UNFURL_OPTIONS,
    });
  return true;
}
