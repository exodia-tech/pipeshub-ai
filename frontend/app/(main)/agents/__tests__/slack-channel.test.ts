import { describe, expect, it } from 'vitest';
import { parseSlackChannel } from '../slack-channel';

describe('Slack destinations', () => {
  it('accepts channel IDs and Slack channel or message links without fetching them', () => {
    for (const value of ['C0C6WPPH5V0', ' https://exodiacore.slack.com/archives/C0C6WPPH5V0/p123 ', 'https://app.slack.com/client/T05840F4M9P/C0C6WPPH5V0']) expect(parseSlackChannel(value)).toBe('C0C6WPPH5V0');
  });
  it('refuses arbitrary URLs, credentials, names and malformed IDs', () => {
    for (const value of ['#company-brain', 'https://slack.com.evil.example/archives/C0C6WPPH5V0', 'https://user:pass@exodiacore.slack.com/archives/C0C6WPPH5V0', 'http://exodiacore.slack.com/archives/C0C6WPPH5V0', 'C1', 'javascript:alert(1)']) expect(parseSlackChannel(value)).toBeNull();
  });
});
