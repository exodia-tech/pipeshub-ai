import axios from 'axios';
import { buildChatStreamUrl, type TypedSlackClient } from './helpers';

export const MAX_SLACK_PREVIEW_BYTES = 20 * 1024 * 1024;

export async function uploadSlackArtifactPreview(client: TypedSlackClient, accessToken: string, conversationId: string | null, agentId: string | null, recordId: string, filename: string, channel: string, threadTs: string): Promise<boolean> {
  if (!client.files || !conversationId || !recordId) return false;
  try {
    const url = buildChatStreamUrl(conversationId, agentId).replace(/\/messages\/stream$/, `/artifacts/${encodeURIComponent(recordId)}/preview`);
    const response = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` }, responseType: 'arraybuffer',
      maxContentLength: MAX_SLACK_PREVIEW_BYTES, maxRedirects: 0, timeout: 60_000 });
    const binary = Buffer.from(response.data);
    if (!binary.length || binary.length > MAX_SLACK_PREVIEW_BYTES) return false;
    await client.files.uploadV2({ channel_id: channel, thread_ts: threadTs, file: binary, filename, title: filename });
    return true;
  } catch { return false; } // The authenticated Brain link remains available when Slack cannot preview a file.
}
