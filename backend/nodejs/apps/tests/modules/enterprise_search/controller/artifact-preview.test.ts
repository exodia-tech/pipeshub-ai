import 'reflect-metadata';
import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import * as repo from '../../../../src/libs/repositories/conversation';
import * as scoped from '../../../../src/modules/enterprise_search/utils/scoped-request';
import { previewConversationArtifactInternal } from '../../../../src/modules/enterprise_search/controller/es_controller';

describe('Slack artifact preview permissions and provenance', () => {
  afterEach(() => sinon.restore());
  const setup = (found = true, artifact = { artifactId: 'record-1', conversationId: 'chat-1', mimeType: 'image/png', sizeInBytes: 5 }) => {
    const req = { params: { conversationId: 'chat-1', recordId: 'record-1' }, headers: { authorization: 'Bearer scoped' }, user: { orgId: 'org-1', userId: 'alice' } };
    const find = sinon.stub().resolves(found ? { _id: 'chat-1' } : null);
    sinon.stub(repo, 'getConversationRepository').returns({ findForTurn: find } as never);
    const hydrate = sinon.stub(scoped, 'hydrateScopedRequestAsUser').resolves();
    const get = sinon.stub(axios, 'get'); get.onFirstCall().resolves({ data: artifact }); get.onSecondCall().resolves({ data: Buffer.from('image') });
    const res = { status: sinon.stub().returnsThis(), send: sinon.stub(), setHeader: sinon.stub() };
    const next = sinon.stub();
    return { req, find, hydrate, get, res, next };
  };
  it('checks caller ownership and both artifact endpoints before returning private bytes', async () => {
    const f = setup();
    await previewConversationArtifactInternal({ connectorBackend: 'http://connector' } as never)(f.req as never, f.res as never, f.next);
    expect(f.find.firstCall.args[2]).to.deep.equal({ orgId: 'org-1', userId: 'alice' });
    expect(f.get.secondCall.args[0]).to.equal('http://connector/api/v1/stream/record/record-1');
    expect(f.res.setHeader.calledWith('Cache-Control', 'private, no-store')).to.equal(true);
    expect(f.res.send.calledOnce).to.equal(true);
    expect(f.next.called).to.equal(false);
  });
  it('does not request any artifact when the conversation is inaccessible', async () => {
    const f = setup(false);
    await previewConversationArtifactInternal({} as never)(f.req as never, f.res as never, f.next);
    expect(f.get.called).to.equal(false); expect(f.next.calledOnce).to.equal(true);
  });
  for (const change of [{ conversationId: 'someone-elses-chat' }, { mimeType: 'text/html' }, { sizeInBytes: 21 * 1024 * 1024 }]) {
    it(`does not download disallowed metadata ${JSON.stringify(change)}`, async () => {
      const f = setup(true, { artifactId: 'record-1', conversationId: 'chat-1', mimeType: 'image/png', sizeInBytes: 5, ...change });
      await previewConversationArtifactInternal({} as never)(f.req as never, f.res as never, f.next);
      expect(f.get.calledOnce).to.equal(true); expect(f.res.send.called).to.equal(false); expect(f.next.calledOnce).to.equal(true);
    });
  }
});
