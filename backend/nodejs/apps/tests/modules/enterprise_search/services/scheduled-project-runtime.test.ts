import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { AuthTokenService } from '../../../../src/libs/services/authtoken.service';
import * as users from '../../../../src/libs/repositories/user';
import { AgentProjectGrants } from '../../../../src/modules/enterprise_search/services/agent-project-grants';
import { ScheduledAgentRuntime } from '../../../../src/modules/enterprise_search/services/scheduled-agent-runtime';
import * as chat from '../../../../src/modules/enterprise_search/utils/non-streaming-chat';
import { AIServiceCommand } from '../../../../src/libs/commands/ai_service/ai.service.command';
import * as admins from '../../../../src/modules/user_management/services/user-admin.service';
import * as bots from '../../../../src/modules/configuration_manager/controller/cm_controller';
import * as scoped from '../../../../src/modules/enterprise_search/utils/scoped-request';

describe('Project schedule runtime', () => {
  afterEach(() => sinon.restore());
  const project = {
    _id: 'project-a',
    name: 'Example',
    knowledgeScope: { apps: ['approved-source'] },
    tools: ['gmail.send_email'],
    isArchived: false,
  };
  const agent = { createdBy: 'owner', isActive: true };
  const schedule = {
    orgId: 'org',
    userId: 'owner',
    agentId: 'agent',
    projectId: 'project-a',
    projectGrantId: 'grant',
    enabled: true,
    days: [1],
    hour: 9,
    minute: 0,
    timezone: 'Europe/Rome',
    prompt: 'Summarize',
    revision: 1,
    nextRunAt: 1,
    coveredLinks: [],
    runs: [],
  };
  const run = {
    id: 'run',
    status: 'running' as const,
    startedAt: 1000,
    periodStart: 0,
    periodEnd: 1000,
  };
  function setup() {
    const policy = sinon.stub(globalThis, 'fetch').callsFake(async () => new Response(JSON.stringify({ scopes: null }), { status: 200 }));
    const getLive = sinon.stub().resolves({
      _id: 'owner',
      orgId: 'org',
      email: 'owner@example.invalid',
      kind: 'human',
      isDisabled: false,
    });
    sinon.stub(users, 'getUserRepository').returns({ getLive });
    sinon
      .stub(AuthTokenService.prototype, 'generateToken')
      .returns('fake-local-test-token');
    const grants = Object.create(
      AgentProjectGrants.prototype,
    ) as AgentProjectGrants;
    const validate = sinon.stub(grants, 'validate').resolves({
      project,
      model: { modelKey: 'key', modelName: 'model', provider: 'provider' },
      modelFingerprint: 'digest',
    });
    const runtime = new ScheduledAgentRuntime(
      () => ({
        jwtSecret: 'test',
        scopedJwtSecret: 'test',
        aiBackend: 'http://test.invalid',
        connectorBackend: 'http://policy.invalid',
      }),
      {},
      grants,
    );
    sinon.stub(runtime, 'checkOwner').resolves(agent);
    const delivery = sinon.stub(runtime, 'checkDelivery');
    const open = sinon
      .stub(chat, 'openConversation')
      .resolves({ _id: 'conversation', orgId: 'org' });
    const complete = sinon.stub(chat, 'completeTurn').resolves({
      conversation: {
        messages: [
          { messageType: 'bot_response', content: 'Review this draft' },
        ],
      },
      recordsUsed: 1,
    });
    return { runtime, validate, open, complete, delivery, getLive, policy };
  }
  it('denies a scheduled project run before reading context when group project access was revoked', async () => {
    const { runtime, policy, validate, open, complete } = setup();
    policy.callsFake(async () => new Response(JSON.stringify({ scopes: ['agent:read', 'agent:execute'] }), { status: 200 }));
    await assert.rejects(runtime.execute(schedule, run, async () => {}), /access group/);
    assert.equal(validate.called, false);
    assert.equal(open.called, false);
    assert.equal(complete.called, false);
  });
  it('rechecks the live scope ceiling immediately before dispatch', async () => {
    const { runtime, policy, complete } = setup();
    policy.onFirstCall().callsFake(async () => new Response(JSON.stringify({ scopes: null }), { status: 200 }));
    policy.onSecondCall().callsFake(async () => new Response(JSON.stringify({ scopes: [] }), { status: 200 }));
    await assert.rejects(runtime.execute(schedule, run, async () => {}), /access group/);
    assert.equal(complete.called, false);
  });
  it('creates an owner-private project draft with pinned model, strict source scope and no actions', async () => {
    const { runtime, validate, open, complete, delivery } = setup();
    const result = await runtime.execute(schedule, run, async () => {});
    assert.equal(validate.callCount, 2);
    assert.equal(delivery.callCount, 0);
    assert.equal(open.firstCall.args[0].projectId, 'project-a');
    assert.equal(open.firstCall.args[0].projectVisibility, 'private');
    assert.equal(open.firstCall.args[0].modelInfo?.modelKey, 'key');
    assert.equal(open.firstCall.args[0].modelInfo?.modelProvider, 'provider');
    assert.equal(complete.firstCall.args[0].modelInfo.modelName, 'model');
    const payload = complete.firstCall.args[0].request.payload;
    assert.deepEqual(payload.tools, []);
    assert.equal(payload.safeRetrievalOnly, true);
    assert.equal(payload.strictScope, true);
    assert.deepEqual(payload.filters, { apps: ['approved-source'], kb: [] });
    assert.equal(payload.modelKey, 'key');
    assert.equal(payload.modelName, 'model');
    assert.equal(payload.safeModelFingerprint, 'digest');
    assert.deepEqual(payload.agentCapabilities, {
      internalSearch: true,
      webSearch: false,
      deepSearch: false,
    });
    assert.equal(result.needsReview, true);
    assert.deepEqual(result.links, []);
    assert.equal(result.slackTs, undefined);
  });
  it('does not call the model if approval is revoked after the run is claimed', async () => {
    const { runtime, validate, open, complete } = setup();
    validate.onSecondCall().rejects(new Error('revoked'));
    let checkpoint = '';
    await assert.rejects(
      runtime.execute(schedule, run, async (id) => {
        checkpoint = id;
      }),
    );
    assert.equal(open.callCount, 1);
    assert.equal(checkpoint, 'conversation');
    assert.equal(complete.callCount, 0);
  });
  it('rejects disabled owners and any project schedule with a Slack destination', async () => {
    const { runtime, getLive, validate, complete } = setup();
    getLive.resolves({ _id: 'owner', orgId: 'org', isDisabled: true });
    await assert.rejects(runtime.execute(schedule, run, async () => {}));
    getLive.resolves({
      _id: 'owner',
      orgId: 'org',
      email: 'owner@example.invalid',
      kind: 'human',
    });
    await assert.rejects(
      runtime.execute(
        { ...schedule, slackChannelId: 'C0C6WPPH5V0' },
        run,
        async () => {},
      ),
    );
    assert.equal(validate.callCount, 0);
    assert.equal(complete.callCount, 0);
  });

  it('does not expose credential-bearing or duplicate links in a public research result', async () => {
    const { runtime, complete, validate } = setup();
    complete.resolves({
      conversation: {
        messages: [
          {
            messageType: 'user_query',
            content: 'https://private.example.invalid',
          },
          {
            messageType: 'bot_response',
            content:
              'Sources: https://example.invalid/a#one https://example.invalid/a#two https://user:secret@example.invalid/private https://[broken',
          },
        ],
      },
      recordsUsed: 0,
    });
    const result = await runtime.execute(
      { ...schedule, projectId: null, projectGrantId: null },
      run,
      async () => {},
    );
    assert.deepEqual(result.links, ['https://example.invalid/a']);
    assert.equal(result.slackTs, undefined);
    assert.equal(validate.callCount, 0);
  });

  it('checks agent ownership and public-research eligibility before settings access', async () => {
    const runtime = new ScheduledAgentRuntime(
      () => ({}),
      {},
      {} as AgentProjectGrants,
    );
    const getAgent = sinon
      .stub(runtime, 'getAgent')
      .resolves({ ...agent, createdBy: 'someone-else' });
    await assert.rejects(
      runtime.checkOwner('agent', 'owner', {}, true),
      /Only the agent creator/,
    );
    getAgent.resolves({
      ...agent,
      knowledge: ['private-folder'],
      toolsets: [],
      mcpServers: [],
      apiToolsetTools: [],
      skills: [],
      sendUserContext: false,
    });
    await assert.rejects(
      runtime.checkOwner('agent', 'owner', {}, true),
      /no company knowledge/,
    );
    getAgent.resolves({
      ...agent,
      knowledge: [],
      toolsets: [],
      mcpServers: [],
      apiToolsetTools: [],
      skills: [],
      sendUserContext: false,
    });
    assert.equal(
      (await runtime.checkOwner('agent', 'owner', {}, true)).createdBy,
      'owner',
    );
  });

  it('refuses unavailable agents and failed avatar updates instead of accepting upstream errors', async () => {
    const runtime = new ScheduledAgentRuntime(
      () => ({ aiBackend: 'http://test.invalid' }),
      {},
      {} as AgentProjectGrants,
    );
    const execute = sinon
      .stub(AIServiceCommand.prototype, 'execute')
      .resolves({ statusCode: 403 });
    await assert.rejects(runtime.getAgent('agent', {}), /not available/);
    await assert.rejects(
      runtime.updateAvatar('agent', null, {}),
      /could not be saved/,
    );
    execute.resolves({ statusCode: 200, data: { agent } });
    assert.deepEqual(await runtime.getAgent('agent', {}), agent);
    await runtime.updateAvatar('agent', null, {});
  });

  it('keeps delivery options private to administrators and reports health outages', async () => {
    const runtime = new ScheduledAgentRuntime(
      () => ({ aiBackend: 'http://test.invalid' }),
      {},
      {} as AgentProjectGrants,
    );
    sinon.stub(admins, 'isUserOrgAdmin').resolves(false);
    assert.deepEqual(await runtime.deliveryOptions('org', 'member', 'agent'), {
      canManage: false,
      bots: [],
    });
    assert.equal(
      await runtime.checkDelivery({
        orgId: 'org',
        userId: 'member',
        agentId: 'agent',
      }),
      null,
    );
    await assert.rejects(
      runtime.checkDelivery({
        orgId: 'org',
        userId: 'member',
        agentId: 'agent',
        slackBotId: 'bot',
        slackChannelId: 'channel',
      }),
      /administrator/,
    );
    const fetch = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(null, { status: 200 }));
    assert.equal(await runtime.isReady(), true);
    fetch.resolves(new Response(null, { status: 503 }));
    assert.equal(await runtime.isReady(), false);
    fetch.rejects(new Error('offline'));
    assert.equal(await runtime.isReady(), false);
  });

  it('lists only the selected agent bots without exposing tokens or accepting another agent bot', async () => {
    const runtime = new ScheduledAgentRuntime(
      () => ({}),
      {},
      {} as AgentProjectGrants,
    );
    sinon.stub(admins, 'isUserOrgAdmin').resolves(true);
    const soleOrg = sinon.stub(scoped, 'resolveSoleOrgId').resolves('org');
    const store = sinon.stub(bots, 'getSlackBotStore').resolves({
      configs: [
        {
          id: 'allowed',
          agentId: 'agent',
          name: 'Briefing bot',
          botToken: 'synthetic-token',
        },
        {
          id: 'other',
          agentId: 'another-agent',
          name: 'Other bot',
          botToken: 'other-token',
        },
      ],
    });
    assert.deepEqual(await runtime.deliveryOptions('org', 'owner', 'agent'), {
      canManage: true,
      bots: [{ id: 'allowed', name: 'Briefing bot' }],
    });
    assert.equal(
      await runtime.checkDelivery({
        orgId: 'org',
        userId: 'owner',
        agentId: 'agent',
        slackBotId: 'allowed',
        slackChannelId: 'channel',
      }),
      'synthetic-token',
    );
    await assert.rejects(
      runtime.checkDelivery({
        orgId: 'org',
        userId: 'owner',
        agentId: 'agent',
        slackBotId: 'other',
        slackChannelId: 'channel',
      }),
      /Connect a Slack bot/,
    );
    soleOrg.resolves('another-org');
    store.resetHistory();
    assert.deepEqual(await runtime.deliveryOptions('org', 'owner', 'agent'), {
      canManage: false,
      bots: [],
    });
    assert.equal(store.callCount, 0);
  });
});
