/** Ordinary messages can grow and later accept final blocks; native streams reject that conversion. */
export class SlackReplyStream {
  private ts?: string;
  private text = '';
  private lastUpdateAt = 0;

  constructor(
    private readonly chat: {
      postMessage: (args: any) => Promise<any>;
      update: (args: any) => Promise<any>;
    },
    private readonly channel: string,
    private readonly threadTs: string,
  ) {}

  async call(method: string, args: Record<string, unknown>): Promise<{ ts?: string }> {
    if (method === 'chat.stopStream' && !args.markdown_text) return { ts: this.ts };
    const next = this.text + (typeof args.markdown_text === 'string' ? args.markdown_text : '');
    if (!this.ts) {
      const result = await this.chat.postMessage({ channel: this.channel, thread_ts: this.threadTs,
        text: next, unfurl_links: false, unfurl_media: false });
      if (!result.ts) throw new Error('Slack reply has no timestamp');
      this.ts = result.ts;
    } else {
      if (method !== 'chat.stopStream' && Date.now() - this.lastUpdateAt < 1100) {
        this.text = next;
        return { ts: this.ts };
      }
      await this.chat.update({ channel: this.channel, ts: this.ts, text: next,
        unfurl_links: false, unfurl_media: false });
    }
    this.text = next;
    this.lastUpdateAt = Date.now();
    return { ts: this.ts };
  }

  async reset(): Promise<void> {
    // Keep the message identity through model retries and tool preambles.
    this.text = '';
  }
}
