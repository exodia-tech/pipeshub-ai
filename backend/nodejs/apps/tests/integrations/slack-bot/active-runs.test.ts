import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import type { TypedSlackClient } from '../../../src/integrations/slack-bot/src/helpers';
import {
  SlackActiveRun,
  slackRunKey,
  trySteerSlackRun,
} from '../../../src/integrations/slack-bot/src/active-runs';

describe('Slack active run routing', () => {
  afterEach(() => sinon.restore());
  const message = {
    user: 'alice',
    channel: 'C1',
    ts: '2.2',
    thread_ts: '1.1',
    text: 'focus on AI',
  };
  it('routes only the same workspace, bot, channel, thread and requester', () => {
    const key = slackRunKey(message, 'bot-a', 'team-a');
    expect(slackRunKey({ ...message, ts: '3.3' }, 'bot-a', 'team-a')).to.equal(
      key,
    );
    for (const change of [
      { user: 'bob' },
      { channel: 'C2' },
      { thread_ts: '4.4' },
    ]) {
      expect(
        slackRunKey({ ...message, ...change }, 'bot-a', 'team-a'),
      ).not.to.equal(key);
    }
    expect(slackRunKey(message, 'bot-b', 'team-a')).not.to.equal(key);
    expect(slackRunKey(message, 'bot-a', 'team-b')).not.to.equal(key);
  });
  it('waits for a new conversation identity and releases on failure', async () => {
    const run = new SlackActiveRun('1.1', null);
    run.conversationCreated('chat-a');
    expect(await run.ready).to.equal('chat-a');
    run.finish();
    await run.done;
    const failed = new SlackActiveRun('1.1', null);
    failed.finish();
    expect(await failed.ready).to.equal(null);
  });
  it('sends text to the existing scoped agent run and acknowledges only once', async () => {
    const post = sinon
      .stub(axios, 'post')
      .resolves({ data: { queued: true, duplicate: false } });
    const ack = sinon.stub().resolves({});
    const client = {
      chat: { postMessage: ack },
    } as unknown as TypedSlackClient;
    const run = new SlackActiveRun('1.1', 'chat-a');
    run.runStarted(run.runId);
    expect(
      await trySteerSlackRun(
        run,
        message,
        client,
        'synthetic-token',
        'agent-a',
      ),
    ).to.equal(true);
    expect(post.firstCall.args[0]).to.match(
      /agents\/agent-a\/conversations\/internal\/chat-a\/steer$/,
    );
    expect(post.firstCall.args[1]).to.deep.equal({
      runId: run.runId,
      text: 'focus on AI',
      messageId: '2.2',
    });
    expect(post.firstCall.args[2]).to.include({ maxRedirects: 0 });
    expect(ack.firstCall.args[0]).to.include({
      channel: 'C1',
      thread_ts: '1.1',
    });
    post.resolves({ data: { queued: true, duplicate: true } });
    expect(
      await trySteerSlackRun(
        run,
        message,
        client,
        'synthetic-token',
        'agent-a',
      ),
    ).to.equal(true);
    expect(ack.callCount).to.equal(1);
  });
  it('leaves finished runs and attachments for the next normal turn', async () => {
    const post = sinon
      .stub(axios, 'post')
      .resolves({ data: { queued: false, duplicate: false } });
    const run = new SlackActiveRun('1.1', 'chat-a');
    run.runStarted(run.runId);
    const client = {
      chat: { postMessage: sinon.stub() },
    } as unknown as TypedSlackClient;
    expect(await trySteerSlackRun(run, message, client, 'test', null)).to.equal(
      false,
    );
    expect(
      await trySteerSlackRun(
        run,
        { ...message, files: [{}] },
        client,
        'test',
        null,
      ),
    ).to.equal(false);
    expect(post.callCount).to.equal(1);
  });
  it('does not start a second run after an ownership or transport error', async () => {
    sinon.stub(axios, 'post').rejects(new Error('private transport detail'));
    const run = new SlackActiveRun('1.1', 'chat-a');
    run.runStarted(run.runId);
    try {
      await trySteerSlackRun(
        run,
        message,
        {} as TypedSlackClient,
        'test',
        null,
      );
      throw new Error('expected delivery failure');
    } catch (error) {
      expect((error as Error).message).to.equal(
        "I couldn't deliver that update to the active run. Please try again.",
      );
    }
  });

  it('buffers a followup until the root run is actually ready', async () => {
    const post = sinon
      .stub(axios, 'post')
      .resolves({ data: { queued: true, duplicate: false } });
    const client = {
      chat: { postMessage: sinon.stub().resolves({}) },
    } as unknown as TypedSlackClient;
    const run = new SlackActiveRun('1.1', null);
    const delivery = trySteerSlackRun(run, message, client, 'test', null);
    run.conversationCreated('chat-a');
    await Promise.resolve();
    expect(post.called).to.equal(false);
    run.runStarted(run.runId);
    expect(await delivery).to.equal(true);
  });
});
