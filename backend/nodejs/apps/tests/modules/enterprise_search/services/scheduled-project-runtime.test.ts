import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { AuthTokenService } from '../../../../src/libs/services/authtoken.service';
import * as users from '../../../../src/libs/repositories/user';
import { AgentProjectGrants } from '../../../../src/modules/enterprise_search/services/agent-project-grants';
import { ScheduledAgentRuntime } from '../../../../src/modules/enterprise_search/services/scheduled-agent-runtime';
import * as chat from '../../../../src/modules/enterprise_search/utils/non-streaming-chat';

describe('Project schedule runtime', () => {
  afterEach(() => sinon.restore());
  const project = { _id: 'project-a', name: 'Example', knowledgeScope: { apps: ['approved-source'] }, tools: ['gmail.send_email'], isArchived: false };
  const agent = { createdBy: 'owner', isActive: true };
  const schedule = { orgId: 'org', userId: 'owner', agentId: 'agent', projectId: 'project-a', projectGrantId: 'grant',
    enabled: true, days: [1], hour: 9, minute: 0, timezone: 'Europe/Rome', prompt: 'Summarize', revision: 1, nextRunAt: 1, coveredLinks: [], runs: [] };
  const run = { id: 'run', status: 'running' as const, startedAt: 1000, periodStart: 0, periodEnd: 1000 };
  function setup() {
    const getLive = sinon.stub().resolves({ _id: 'owner', orgId: 'org', email: 'owner@example.invalid', kind: 'human', isDisabled: false });
    sinon.stub(users, 'getUserRepository').returns({ getLive });
    sinon.stub(AuthTokenService.prototype, 'generateToken').returns('fake-local-test-token');
    const grants = Object.create(AgentProjectGrants.prototype) as AgentProjectGrants;
    const validate = sinon.stub(grants, 'validate').resolves({ project, model: { modelKey: 'key', modelName: 'model' }, modelFingerprint: 'digest' });
    const runtime = new ScheduledAgentRuntime(() => ({ jwtSecret: 'test', scopedJwtSecret: 'test', aiBackend: 'http://test.invalid' }), {}, grants);
    sinon.stub(runtime, 'checkOwner').resolves(agent);
    const delivery = sinon.stub(runtime, 'checkDelivery');
    const open = sinon.stub(chat, 'openConversation').resolves({ _id: 'conversation', orgId: 'org' });
    const complete = sinon.stub(chat, 'completeTurn').resolves({ conversation: { messages: [{ messageType: 'bot_response', content: 'Review this draft' }] }, recordsUsed: 1 });
    return { runtime, validate, open, complete, delivery, getLive };
  }
  it('creates an owner-private project draft with pinned model, strict source scope and no actions', async () => {
    const { runtime, validate, open, complete, delivery } = setup();
    const result = await runtime.execute(schedule, run, async () => {});
    assert.equal(validate.callCount, 2); assert.equal(delivery.callCount, 0);
    assert.equal(open.firstCall.args[0].projectId, 'project-a');
    assert.equal(open.firstCall.args[0].projectVisibility, 'private');
    const payload = complete.firstCall.args[0].request.payload;
    assert.deepEqual(payload.tools, []); assert.equal(payload.safeRetrievalOnly, true);
    assert.equal(payload.strictScope, true); assert.deepEqual(payload.filters, { apps: ['approved-source'], kb: [] });
    assert.equal(payload.modelKey, 'key'); assert.equal(payload.modelName, 'model'); assert.equal(payload.safeModelFingerprint, 'digest');
    assert.deepEqual(payload.agentCapabilities, { internalSearch: true, webSearch: false, deepSearch: false });
    assert.equal(result.needsReview, true); assert.deepEqual(result.links, []); assert.equal(result.slackTs, undefined);
  });
  it('does not call the model if approval is revoked after the run is claimed', async () => {
    const { runtime, validate, open, complete } = setup();
    validate.onSecondCall().rejects(new Error('revoked'));
    let checkpoint = '';
    await assert.rejects(runtime.execute(schedule, run, async id => { checkpoint = id; }));
    assert.equal(open.callCount, 1); assert.equal(checkpoint, 'conversation'); assert.equal(complete.callCount, 0);
  });
  it('rejects disabled owners and any project schedule with a Slack destination', async () => {
    const { runtime, getLive, validate, complete } = setup();
    getLive.resolves({ _id: 'owner', orgId: 'org', isDisabled: true });
    await assert.rejects(runtime.execute(schedule, run, async () => {}));
    getLive.resolves({ _id: 'owner', orgId: 'org', email: 'owner@example.invalid', kind: 'human' });
    await assert.rejects(runtime.execute({ ...schedule, slackChannelId: 'C0C6WPPH5V0' }, run, async () => {}));
    assert.equal(validate.callCount, 0); assert.equal(complete.callCount, 0);
  });
});
