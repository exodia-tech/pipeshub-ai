/** Accept copied Slack channel/message links as well as a channel ID. Never resolves names or fetches a pasted URL. */
export function parseSlackChannel(value: string): string | null {
  const id = /^[CG][A-Z0-9]{8,20}$/;
  const text = value.trim();
  if (id.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.username || url.password || url.protocol !== 'https:' || !url.hostname.endsWith('.slack.com')) return null;
    const match = url.pathname.match(/^\/(?:client\/[A-Z0-9]+|archives)\/([CG][A-Z0-9]{8,20})(?:\/|$)/);
    return match?.[1] ?? null;
  } catch { return null; }
}
