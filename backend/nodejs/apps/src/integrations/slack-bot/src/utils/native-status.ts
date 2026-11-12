/** Slack's native status rotates while the model is working and clears on reply. */
const THINKING_MESSAGES = [
  'Connecting the dots…',
  'Warming up the brain cells…',
  'Following a promising thought…',
  'Making the pieces fit…',
  'Brewing an answer…',
  'Giving the gears a spin…',
];

export class SlackNativeStatus {
  private active = false;
  private lastStatus = '';

  constructor(
    private readonly apiCall: (method: string, args: Record<string, unknown>) => Promise<unknown>,
    private readonly channel: string,
    private readonly threadTs: string,
  ) {}

  async start(): Promise<boolean> {
    try {
      const result = await this.apiCall('assistant.threads.setStatus', {
        channel_id: this.channel,
        thread_ts: this.threadTs,
        status: 'is thinking…',
        loading_messages: THINKING_MESSAGES,
      });
      this.active = !(result && typeof result === 'object' && 'ok' in result && result.ok === false);
      if (this.active) this.lastStatus = 'thinking';
      return this.active;
    } catch {
      this.active = false;
      return false;
    }
  }

  async update(status: string): Promise<boolean> {
    if (!this.active) return false;
    const phase = status.toLowerCase().startsWith('thinking') ? 'thinking'
      : status.toLowerCase().startsWith('writing reply') ? 'writing' : status;
    // Duplicate snapshots must not restart Slack's rotation or move an answer back to thinking.
    if (phase === this.lastStatus || (phase === 'thinking' && this.lastStatus === 'writing')) return true;
    try {
      const result = await this.apiCall('assistant.threads.setStatus', {
        channel_id: this.channel,
        thread_ts: this.threadTs,
        status: status ? `is ${status.charAt(0).toLowerCase()}${status.slice(1)}` : '',
        ...(phase === 'thinking' ? { loading_messages: THINKING_MESSAGES }
          : phase === 'writing' ? { loading_messages: ['Putting it into words…', 'Adding the finishing touches…', 'Wrapping up the thought…'] } : {}),
      });
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) throw new Error('Slack status rejected');
      this.lastStatus = phase;
      return true;
    } catch {
      this.active = false;
      return false;
    }
  }

  async clear(): Promise<void> {
    if (this.active) await this.update('');
    this.active = false;
  }
}
