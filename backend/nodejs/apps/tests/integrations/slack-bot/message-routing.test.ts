import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import * as conversations from '../../../src/integrations/slack-bot/src/utils/conversation';
import { shouldHandleSlackMessage } from '../../../src/integrations/slack-bot/src/message-routing';
import { type TypedSlackClient } from '../../../src/integrations/slack-bot/src/helpers';
import * as helpers from '../../../src/integrations/slack-bot/src/helpers';

describe('Slack thread continuation', () => {
  let identity: sinon.SinonStub;
  beforeEach(() => { identity = sinon.stub(helpers, 'resolveOwnBotIdentity').resolves({ userId: 'ULORENZO' }); });
  afterEach(() => sinon.restore());
  it('accepts an unmentioned reply in the same users existing bot thread', async () => {
    const lookup = sinon.stub(conversations, 'getFromDatabase').resolves('existing-brain-conversation');
    const info = sinon.stub().resolves({ user: { profile: { email: 'member@example.invalid' } } });
    const client = { users: { info } } as unknown as TypedSlackClient;
    const reply = { channel: 'CFOUNDERS', user: 'UMEMBER', ts: '100.2', thread_ts: '100.0', text: 'what events are there to attend' };
    assert.equal(await shouldHandleSlackMessage(reply, client, { botUserId: 'ULORENZO' }, 'lorenzo-config'), true);
    assert.deepEqual(lookup.firstCall.args, ['100.0', 'lorenzo-config', 'member@example.invalid']);
    const conversation = await conversations.getFromDatabase('100.0', 'lorenzo-config', 'member@example.invalid');
    assert.ok(helpers.buildChatStreamUrl(conversation, 'lorenzo-agent').endsWith('/agents/lorenzo-agent/conversations/internal/existing-brain-conversation/messages/stream'));
  });
  it('ignores unrelated channel messages, other members/bots and duplicate mention deliveries', async () => {
    const lookup = sinon.stub(conversations, 'getFromDatabase').resolves(null);
    const info = sinon.stub().resolves({ user: { profile: { email: 'other@example.invalid' } } });
    const client = { users: { info } } as unknown as TypedSlackClient;
    const reply = { channel: 'CFOUNDERS', user: 'UMEMBER', ts: '100.2', thread_ts: '100.0', text: 'follow-up' };
    for (const message of [
      { ...reply, thread_ts: undefined }, { ...reply, ts: '100.0' },
      { ...reply, bot_id: 'BOTHER' }, { ...reply, user: 'ULORENZO' },
      { ...reply, subtype: 'bot_message' }, { ...reply, text: '<@ULORENZO> follow-up' },
      { ...reply, text: '<@ULORENZO|Lorenzo> follow-up' },
    ]) assert.equal(await shouldHandleSlackMessage(message, client, {}, 'lorenzo-config'), false);
    assert.equal(lookup.callCount, 0);
    assert.equal(await shouldHandleSlackMessage(reply, client, {}, 'lorenzo-config'), false);
    assert.deepEqual(lookup.firstCall.args, ['100.0', 'lorenzo-config', 'other@example.invalid']);
    assert.equal(await shouldHandleSlackMessage(reply, client, {}, undefined), false);
  });
  it('keeps DMs working and refuses channel continuation without verified identities', async () => {
    const lookup = sinon.stub(conversations, 'getFromDatabase').resolves('conversation');
    const info = sinon.stub().resolves({ user: { profile: {} } });
    const client = { users: { info } } as unknown as TypedSlackClient;
    const reply = { channel: 'CFOUNDERS', user: 'UMEMBER', ts: '100.2', thread_ts: '100.0', text: 'follow-up' };
    assert.equal(await shouldHandleSlackMessage({ ...reply, channel: 'DPRIVATE' }, client, {}, 'lorenzo-config'), true);
    assert.equal(info.callCount, 0);
    assert.equal(await shouldHandleSlackMessage(reply, client, {}, 'lorenzo-config'), false);
    assert.equal(lookup.callCount, 0);
    identity.resolves({});
    assert.equal(await shouldHandleSlackMessage(reply, client, {}, 'lorenzo-config'), false);
    info.rejects(new Error('Slack unavailable'));
    identity.resolves({ userId: 'ULORENZO' });
    const log = sinon.stub(console, 'error');
    assert.equal(await shouldHandleSlackMessage(reply, client, {}, 'lorenzo-config'), false);
    info.resolves({ user: { profile: { email: 'member@example.invalid' } } });
    lookup.rejects(new Error('Mapping unavailable'));
    assert.equal(await shouldHandleSlackMessage(reply, client, {}, 'lorenzo-config'), false);
    assert.equal(log.callCount, 2);
  });
});

