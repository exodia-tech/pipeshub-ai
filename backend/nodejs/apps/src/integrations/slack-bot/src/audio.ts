import axios from 'axios';
import FormData from 'form-data';
import { downloadSlackFile, type SlackFile, type TypedSlackClient } from './helpers';

export function nativeSlackTranscript(file: SlackFile): string | null {
  const t = file.transcription;
  if (!t || ![undefined, 'complete', 'completed', 'available'].includes(t.status)) return null;
  if (t.preview?.has_more === false && t.preview.content?.trim()) return t.preview.content.trim();
  if (t.has_more === true) return null;
  if (t.text?.trim()) return t.text.trim();
  if (t.lines?.length && t.lines.every(line => typeof line.contents === 'string' && line.contents.trim()))
    return t.lines.map(line => line.contents!.trim()).join('\n');
  return null;
}

export function slackCaptionText(vtt: string): string | null {
  if (!vtt.trimStart().startsWith('WEBVTT')) return null;
  const cues = vtt.replace(/\r/g, '').split(/\n\s*\n/).slice(1);
  const text = cues.flatMap(cue => {
    const lines = cue.split('\n');
    const timing = lines.findIndex(line => /^\d{2}:\d{2}(?::\d{2})?\.\d{3}\s+-->/.test(line));
    return timing < 0 ? [] : [lines.slice(timing + 1).join(' ').replace(/<[^>]*>/g, '')];
  }).filter(Boolean).join('\n');
  return text.trim() || null;
}

export async function transcribeSlackAudio(file: SlackFile, client: TypedSlackClient, botToken: string, accessToken: string): Promise<string> {
  // Refresh because message events often precede Slack's completed transcription.
  const fresh = await client.apiCall('files.info', { file: file.id });
  const current = fresh.file as SlackFile | undefined;
  if (!current || current.id !== file.id) throw new Error('Slack could not verify access to this audio clip.');
  const native = nativeSlackTranscript(current);
  if (native) return native;
  if (current.vtt) {
    try {
      const caption = current.vtt.startsWith('https://')
        ? (await downloadSlackFile({ id: current.id, url_private: current.vtt }, botToken)).toString('utf8')
        : current.vtt;
      const text = slackCaptionText(caption);
      if (text) return text;
    } catch { /* A missing caption can still be transcribed from the audio. */ }
  }
  const binary = await downloadSlackFile(current, botToken);
  if (!binary.length) throw new Error('Slack returned an empty audio clip.');
  const form = new FormData();
  form.append('file', binary, { filename: current.name || 'audio.m4a', contentType: current.mimetype || 'audio/mp4' });
  try {
    const result = await axios.post(`${process.env.BACKEND_URL || 'http://localhost:3000'}/api/v1/chat/internal/transcribe`, form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${accessToken}` }, timeout: 120_000, maxRedirects: 0 });
    const text = result.data?.text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  } catch { /* Do not expose upstream configuration or audio in Slack errors. */ }
  throw new Error("I couldn't transcribe this audio clip. An administrator may need to configure Speech-to-Text; please retry or send the text.");
}
