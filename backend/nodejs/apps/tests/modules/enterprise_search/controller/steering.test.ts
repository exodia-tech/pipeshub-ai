import 'reflect-metadata';
import { expect } from 'chai';
import sinon from 'sinon';
import * as repo from '../../../../src/libs/repositories/conversation';
import * as utils from '../../../../src/modules/enterprise_search/utils/utils';
import { AIServiceCommand } from '../../../../src/libs/commands/ai_service/ai.service.command';
import { steerConversationStream, steerConversationStreamInternal } from '../../../../src/modules/enterprise_search/controller/es_controller';

describe('Steering conversation ownership and history', () => {
  afterEach(() => sinon.restore());
  function setup(queued = true, duplicate = false, found = true) {
    const findForTurn = sinon
      .stub()
      .resolves(found ? { _id: 'chat-a', orgId: 'org-a' } : null);
    sinon
      .stub(repo, 'getConversationRepository')
      .returns({ findForTurn } as never);
    const append = sinon.stub(utils, 'appendMessages').resolves([]);
    const forward = sinon
      .stub(AIServiceCommand.prototype, 'execute')
      .resolves({ statusCode: 200, data: { queued, duplicate } } as never);
    const req = {
      params: { conversationId: 'chat-a' },
      user: { userId: 'alice', orgId: 'org-a' },
      headers: { authorization: 'test' },
      body: { runId: 'run-a', messageId: 'm1', text: 'Only the AI project' },
    };
    const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };
    const next = sinon.stub();
    return { findForTurn, append, forward, req, res, next };
  }
  it('checks the verified user and appends the accepted clarification', async () => {
    const f = setup();
    await steerConversationStream({ aiBackend: 'http://query.test' } as never)(
      f.req as never,
      f.res as never,
      f.next,
    );
    expect(f.findForTurn.firstCall.args).to.deep.equal([
      { kind: 'chat' },
      'chat-a',
      { orgId: 'org-a', userId: 'alice' },
    ]);
    expect(f.forward.calledOnce).to.equal(true);
    expect(f.append.firstCall.args[0]).to.equal('chat-a');
    expect(f.append.firstCall.args[2][0].content).to.equal(
      'Only the AI project',
    );
    expect(f.next.called).to.equal(false);
  });
  it('refuses new named-agent instructions after the registered caller loses execution access', async () => {
    const f = setup();
    Object.assign(f.req.params, { agentKey: 'named-agent' });
    Object.assign(f.req, { resolveFeatureScopes: async () => {
      Object.assign(f.req.user, { featureScopes: ['conversation:chat'] });
    } });
    await steerConversationStreamInternal({ aiBackend: 'http://query.test' } as never, true)(
      f.req as never, f.res as never, f.next,
    );
    expect(f.next.firstCall?.args[0]).to.have.property('statusCode', 403);
    expect(f.findForTurn.called).to.equal(false);
    expect(f.forward.called).to.equal(false);
    expect(f.append.called).to.equal(false);
  });
  it('does not forward or persist when the conversation is unauthorized', async () => {
    const f = setup(true, false, false);
    await steerConversationStream({ aiBackend: 'http://query.test' } as never)(
      f.req as never,
      f.res as never,
      f.next,
    );
    expect(f.forward.called).to.equal(false);
    expect(f.append.called).to.equal(false);
    expect(f.next.calledOnce).to.equal(true);
  });
  for (const [queued, duplicate] of [
    [true, true],
    [false, false],
  ]) {
    it(`does not add a duplicate or undelivered message (${queued},${duplicate})`, async () => {
      const f = setup(queued, duplicate);
      await steerConversationStream({
        aiBackend: 'http://query.test',
      } as never)(f.req as never, f.res as never, f.next);
      expect(f.append.called).to.equal(false);
      expect(f.res.json.firstCall.args[0]).to.deep.equal({ queued, duplicate });
    });
  }
});
