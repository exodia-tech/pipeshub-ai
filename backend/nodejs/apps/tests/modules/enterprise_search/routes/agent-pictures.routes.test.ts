import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import express from 'express';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import sinon from 'sinon';
import { Container } from 'inversify';
import { AuthenticatedUserRequest } from '../../../../src/libs/middlewares/types';
import { createAgentPictureRouter } from '../../../../src/modules/enterprise_search/routes/agent-pictures.routes';
import { asAccount } from '../../../../src/libs/context/orgContext';
import { ScheduledAgentRuntime } from '../../../../src/modules/enterprise_search/services/scheduled-agent-runtime';
import { AgentPictures } from '../../../../src/modules/enterprise_search/services/agent-pictures';
import { BadRequestError } from '../../../../src/libs/errors/http.errors';

describe('Agent picture access boundaries', () => {
  afterEach(() => sinon.restore());
  it('checks authentication, scopes, creator ownership and read visibility before accessing image bytes', async () => {
    let authenticated = false; let scopes = ['agent:read'];
    const container = new Container();
    container.bind('AuthMiddleware').toConstantValue({ authenticate: (req: AuthenticatedUserRequest, res: express.Response, next: express.NextFunction) => {
      if (!authenticated) { res.sendStatus(401); return; }
      req.user = { userId: 'owner', orgId: 'untrusted-request-org', isOAuth: true, oauthScopes: scopes };
      asAccount('org', 'owner', 'test:verified-auth', next);
    } });
    const runtime = Object.create(ScheduledAgentRuntime.prototype) as ScheduledAgentRuntime;
    const owner = sinon.stub(runtime, 'checkOwner').rejects(new Error('creator only'));
    const visible = sinon.stub(runtime, 'getAgent').rejects(new Error('not visible'));
    const pictures = Object.create(AgentPictures.prototype) as AgentPictures;
    const upload = sinon.stub(pictures, 'upload').resolves('/private-picture');
    const read = sinon.stub(pictures, 'read').resolves('data:image/webp;base64,test');
    const remove = sinon.stub(pictures, 'remove').resolves();
    container.bind(ScheduledAgentRuntime).toConstantValue(runtime); container.bind(AgentPictures).toConstantValue(pictures);
    const app = express(); app.use('/agents/:agentKey/avatar', createAgentPictureRouter(container));
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err instanceof BadRequestError ? 400 : 403).json({ error: err.message }); });
    const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const path = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agents/e6ed44ce-65cc-42db-95bc-5db456f5f450/avatar`;
    const version = '/120d1a70-989a-499b-8e41-170b2a07a820';
    const sendImage = () => { const body = new FormData(); body.set('file', new Blob(['image'], { type: 'image/png' }), 'face.png'); return fetch(path, { method: 'PUT', body }); };
    try {
      assert.equal((await fetch(path + version)).status, 401); assert.equal(visible.callCount, 0);
      authenticated = true;
      assert.equal((await sendImage()).status, 403); assert.equal(owner.callCount, 0);
      scopes.push('agent:write');
      assert.equal((await sendImage()).status, 403); assert.equal(upload.callCount, 0);
      assert.equal((await fetch(path, { method: 'DELETE' })).status, 403); assert.equal(remove.callCount, 0);
      assert.equal((await fetch(path + version)).status, 403); assert.equal(read.callCount, 0);
      visible.resolves({ avatarUrl: '/current' });
      const response = await fetch(path + version);
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(read.firstCall.args[0], 'org');
      owner.resolves({ avatarUrl: '/previous' });
      const oversized = new FormData(); oversized.set('file', new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]), 'huge.png');
      assert.equal((await fetch(path, { method: 'PUT', body: oversized })).status, 400);
      assert.equal(upload.callCount, 0);
      const extra = new FormData(); extra.set('unexpected', 'value');
      assert.equal((await fetch(path, { method: 'PUT', body: extra })).status, 400);
      assert.equal((await sendImage()).status, 201); assert.equal(upload.firstCall.args[0], 'org');
      assert.equal((await fetch(path, { method: 'DELETE' })).status, 200);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
