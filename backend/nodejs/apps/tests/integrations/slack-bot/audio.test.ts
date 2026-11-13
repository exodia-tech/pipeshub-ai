import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import { nativeSlackTranscript, slackCaptionText, transcribeSlackAudio } from '../../../src/integrations/slack-bot/src/audio';
import { downloadSlackFile, handleIncomingAttachments, type TypedSlackClient } from '../../../src/integrations/slack-bot/src/helpers';

describe('Slack bot audio input', () => {
  afterEach(() => sinon.restore());
  const file = { id: 'F1', name: 'clip.m4a', filetype: 'm4a', mimetype: 'audio/mp4', url_private: 'https://files.slack.com/clip' };
  const client = () => ({ apiCall: sinon.stub().resolves({ file }), chat: { postMessage: sinon.stub().resolves({}) } }) as unknown as TypedSlackClient;

  it('accepts an audio-only mention without posting an unsupported notice', async () => {
    const c = client();
    expect((await handleIncomingAttachments(c, { ts: '1.1', text: '<@BOT>', files: [file] }, 'BOT')).shouldAnswer).to.equal(true);
    expect((c.chat.postMessage as sinon.SinonStub).called).to.equal(false);
  });
  it('rejects partial native transcripts', () => {
    expect(nativeSlackTranscript({ ...file, transcription: { status: 'pending', text: 'partial' } })).to.equal(null);
    expect(nativeSlackTranscript({ ...file, transcription: { has_more: true, text: 'partial' } })).to.equal(null);
    expect(nativeSlackTranscript({ ...file, transcription: { preview: { has_more: false, content: 'complete' } } })).to.equal('complete');
  });
  it('uses a fresh complete native transcript without downloading or making a model call', async () => {
    const c = client();
    (c.apiCall as sinon.SinonStub).resolves({ file: { ...file, transcription: { text: 'Focus on AI' } } });
    const get = sinon.stub(axios, 'get'); const post = sinon.stub(axios, 'post');
    expect(await transcribeSlackAudio(file, c, 'bot', 'caller')).to.equal('Focus on AI');
    expect(get.called || post.called).to.equal(false);
  });
  it('extracts complete VTT cues and ignores metadata', () => {
    expect(slackCaptionText('WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nFocus on AI\n')).to.equal('Focus on AI');
    expect(slackCaptionText('not captions')).to.equal(null);
  });
  it('uses caller-scoped transcription when Slack has no transcript', async () => {
    sinon.stub(axios, 'get').resolves({ data: Buffer.from('audio') });
    const post = sinon.stub(axios, 'post').resolves({ data: { text: 'Transcript' } });
    expect(await transcribeSlackAudio(file, client(), 'bot', 'caller')).to.equal('Transcript');
    expect(post.firstCall.args[0]).to.contain('/chat/internal/transcribe');
    expect(post.firstCall.args[2]?.headers?.Authorization).to.equal('Bearer caller');
  });
  it('does not send credentials to an arbitrary host or follow redirects', async () => {
    const get = sinon.stub(axios, 'get').resolves({ data: Buffer.from('audio') });
    for (const url of ['https://evil.example/clip', 'http://files.slack.com/clip', 'https://user:pass@files.slack.com/clip']) {
      try { await downloadSlackFile({ ...file, url_private: url }, 'bot'); expect.fail('accepted unsafe URL'); }
      catch (e) { expect(String(e)).to.contain('Unsupported Slack'); }
    }
    expect(get.called).to.equal(false);
    await downloadSlackFile(file, 'bot');
    expect(get.firstCall.args[1]?.maxRedirects).to.equal(0);
  });
  it('fails clearly rather than treating missing transcription as a greeting', async () => {
    sinon.stub(axios, 'get').resolves({ data: Buffer.from('audio') });
    sinon.stub(axios, 'post').rejects(new Error('private upstream details'));
    try { await transcribeSlackAudio(file, client(), 'bot', 'caller'); expect.fail('accepted failure'); }
    catch (e) { expect(String(e)).to.contain('configure Speech-to-Text').and.not.contain('private upstream'); }
  });
});
