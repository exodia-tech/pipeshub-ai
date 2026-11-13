import { expect } from 'chai';
import sinon from 'sinon';
import { SlackReplyStream } from '../../../src/integrations/slack-bot/src/utils/reply-stream';

describe('Slack reply message identity', () => {
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => { clock = sinon.useFakeTimers(); });
  afterEach(() => clock.restore());
  it('coalesces rapid tokens without losing text or waiting behind a timer queue', async () => {
    const chat = { postMessage: sinon.stub().resolves({ ts: '1.2' }), update: sinon.stub().resolves({ ts: '1.2' }) };
    const stream = new SlackReplyStream(chat, 'C1', '1.0');
    await stream.call('chat.startStream', { markdown_text: 'A' });
    await stream.call('chat.appendStream', { markdown_text: 'B' });
    expect(chat.update.called).to.equal(false);
    clock.tick(1100);
    await stream.call('chat.appendStream', { markdown_text: 'C' });
    expect(chat.update.lastCall.args[0].text).to.equal('ABC');
  });
  it('grows one ordinary message and accepts final citation/table blocks without deleting or reposting', async () => {
    let message: Record<string, unknown> = {};
    const chat = {
      postMessage: sinon.stub().callsFake(async (args) => { message = args; return { ts: '1.2' }; }),
      update: sinon.stub().callsFake(async (args) => { message = args; return { ts: '1.2' }; }),
    };
    const stream = new SlackReplyStream(chat, 'C1', '1.0');
    await stream.call('chat.startStream', { markdown_text: 'Hello' });
    clock.tick(1100);
    await stream.call('chat.appendStream', { markdown_text: ' world' });
    expect(message.text).to.equal('Hello world');
    await stream.call('chat.stopStream', {});
    const blocks = [{ type: 'table', rows: [] }, { type: 'section', text: { type: 'mrkdwn', text: 'Sources' } }];
    await chat.update({ channel: 'C1', ts: '1.2', text: '', blocks });
    expect(message.blocks).to.equal(blocks);
    expect(chat.postMessage.callCount).to.equal(1);
    expect(chat.update.getCalls().every((call) => call.args[0].ts === '1.2')).to.equal(true);
  });

  it('reuses the same message after a discarded model attempt', async () => {
    const chat = { postMessage: sinon.stub().resolves({ ts: '1.2' }), update: sinon.stub().resolves({ ts: '1.2' }) };
    const stream = new SlackReplyStream(chat, 'C1', '1.0');
    await stream.call('chat.startStream', { markdown_text: 'Discarded' });
    await stream.reset();
    clock.tick(1100);
    expect((await stream.call('chat.startStream', { markdown_text: 'Correct answer' })).ts).to.equal('1.2');
    expect(chat.update.lastCall.args[0].text).to.equal('Correct answer');
    expect(chat.postMessage.callCount).to.equal(1);
  });

  it('retains the successful prefix when an update fails', async () => {
    const chat = { postMessage: sinon.stub().resolves({ ts: '1.2' }), update: sinon.stub() };
    const stream = new SlackReplyStream(chat, 'C1', '1.0');
    await stream.call('chat.startStream', { markdown_text: 'Hello' });
    clock.tick(1100);
    chat.update.onFirstCall().rejects(new Error('rate_limited'));
    try { await stream.call('chat.appendStream', { markdown_text: ' retry' }); } catch {}
    chat.update.onSecondCall().resolves({ ts: '1.2' });
    await stream.call('chat.appendStream', { markdown_text: ' again' });
    expect(chat.update.lastCall.args[0].text).to.equal('Hello again');
    expect(chat.postMessage.callCount).to.equal(1);
  });
  for (const partialAlreadyVisible of [true, false]) {
    it(`keeps contextual steering and the final answer in one reply (partial visible: ${partialAlreadyVisible})`, async () => {
      const chat = { postMessage: sinon.stub().resolves({ ts: '1.2' }), update: sinon.stub().resolves({ ts: '1.2' }) };
      const stream = new SlackReplyStream(chat, 'C1', '1.0');
      if (partialAlreadyVisible) await stream.call('chat.startStream', { markdown_text: 'I’ll switch' });
      await stream.reset();
      await stream.call('chat.stopStream', { markdown_text: 'I’ll switch to a green rounded square.' });
      await stream.reset();
      expect(chat.postMessage.callCount).to.equal(1);
      clock.tick(1100);
      await stream.call('chat.startStream', { markdown_text: 'Here is the updated green design.' });
      expect(chat.postMessage.callCount).to.equal(1);
      expect(chat.update.lastCall.args[0]).to.include({ ts: '1.2', text: 'Here is the updated green design.' });
    });
  }
});
