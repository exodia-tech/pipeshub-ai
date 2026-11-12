import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import { Container } from 'inversify';
import mongoose from 'mongoose';
import sinon from 'sinon';
import jwt from 'jsonwebtoken';
import { asAccount } from '../../../src/libs/context/orgContext';
import { TokenScopes } from '../../../src/libs/enums/token-scopes.enum';
import { createAuditRouter } from '../../../src/modules/audit/audit.routes';
import * as admins from '../../../src/modules/user_management/services/user-admin.service';
import { createAccessGroupsRouter } from '../../../src/modules/user_management/routes/accessGroups.routes';
import { FakeBackend } from '../tokens_manager/routes/connectors-http-harness';

describe('Audit history HTTP with unavailable storage', () => {
  const org = '64b000000000000000000a01';
  const actor = '64b0000000000000000000a1';
  let server: Server;
  let base: string;
  let admin: sinon.SinonStub;
  let find: sinon.SinonStub;
  let create: sinon.SinonStub;
  let backend: FakeBackend;

  beforeEach(async () => {
    backend = new FakeBackend();
    await backend.start();
    admin = sinon.stub(admins, 'isUserOrgAdmin').resolves(true);
    const events = mongoose.model('exodiaAuditEvent');
    find = sinon.stub(events, 'find').returns({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            {
              _id: new mongoose.Types.ObjectId('64b000000000000000000e01'),
              org_id: org,
              actor_id: actor,
              operation_id: 'operation',
              action: 'group.create',
              outcome: 'success',
              group_ids: [],
              member_ids: [],
              recorded_at: new Date('2026-11-01T12:00:00Z'),
              unexpected_secret: 'must-not-escape',
            },
          ],
        }),
      }),
    } as never);
    create = sinon.stub(events, 'create').resolves({} as never);
    const container = new Container();
    container.bind('AppConfig').toConstantValue({
      connectorBackend: backend.url,
      scopedJwtSecret: 'synthetic-test-secret',
    });
    container.bind('AuthMiddleware').toConstantValue({
      authenticate: (
        req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
      ) => {
        Object.assign(req, {
          user: { userId: actor, orgId: org, isOAuth: false },
        });
        asAccount(org, actor, 'test:verified-auth', next);
      },
      scopedTokenValidator:
        () =>
        (
          req: express.Request,
          _res: express.Response,
          next: express.NextFunction,
        ) => {
          Object.assign(req, {
            tokenPayload: {
              orgId: org,
              userId: actor,
              scopes: [TokenScopes.AUDIT_WRITE],
              exp: Math.floor(Date.now() / 1000) + 300,
            },
          });
          next();
        },
    });
    const app = express();
    app.use(express.json());
    app.use('/groups', createAccessGroupsRouter(container));
    app.use(createAuditRouter(container));
    app.use(
      (
        error: { statusCode?: number; message: string },
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        if (res.headersSent) return _next(error);
        res.status(error.statusCode ?? 500).json({ error: error.message });
      },
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await backend.stop();
    sinon.restore();
  });

  it('returns only safe metadata from the verified organization and audits the read', async () => {
    const response = await fetch(`${base}/?org_id=another-tenant`);
    assert.equal(response.status, 200);
    assert.deepEqual(find.firstCall.args[0], { org_id: org });
    const page = (await response.json()) as {
      events: Record<string, unknown>[];
    };
    assert.equal(page.events[0].operation_id, 'operation');
    assert.equal(page.events[0].unexpected_secret, undefined);
    assert.equal(create.firstCall.args[0].org_id, org);
    assert.equal(create.firstCall.args[0].action, 'audit.read');
  });

  it('denies a member without reading or writing audit storage', async () => {
    admin.resolves(false);
    assert.equal((await fetch(base)).status, 403);
    assert.equal(find.callCount, 0);
    assert.equal(create.callCount, 0);
  });

  it('withholds history if its access audit cannot be saved', async () => {
    create.rejects(new Error('private database failure'));
    const response = await fetch(base);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.ok(!body.includes('operation'));
    assert.ok(!body.includes('private database failure'));
  });

  it('does not acknowledge a replay when duplicate-event reconciliation storage fails', async () => {
    const events = mongoose.model('exodiaAuditEvent');
    sinon.stub(events, 'init').resolves(events);
    create.rejects(Object.assign(new Error('duplicate'), { code: 11000 }));
    sinon.stub(events, 'findOne').returns({
      lean: () => Promise.reject(new Error('private database failure')),
    } as never);
    const response = await fetch(`${base}/internal/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event_id: randomUUID(),
        action: 'agent.run',
        outcome: 'success',
        agent_event: { run_id: 'run', trace_id: 'trace', agent_id: 'agent' },
      }),
    });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('private database failure'));
  });

  it('forwards only an allowed rename with a scoped identity and audits intent and success', async () => {
    const group = randomUUID();
    backend.on('PUT', `/api/v1/entity/access-groups/${group}`, {
      status: 200,
      body: { success: true },
    });
    const response = await fetch(`${base}/groups/${group}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: ' New name ',
        orgId: 'another-tenant',
        role: 'admin',
      }),
    });
    assert.equal(response.status, 200);
    const [call] = backend.calls;
    assert.deepEqual(call.body, { name: 'New name' });
    const token = jwt.verify(
      String(call.headers.authorization).slice('Bearer '.length),
      'synthetic-test-secret',
    ) as jwt.JwtPayload;
    assert.equal(token.orgId, org);
    assert.equal(token.userId, actor);
    assert.deepEqual(token.scopes, [TokenScopes.ACCESS_GROUP_MANAGE]);
    assert.deepEqual(
      create
        .getCalls()
        .map((call) => [call.args[0].action, call.args[0].outcome]),
      [
        ['group.rename', 'intent'],
        ['group.rename', 'success'],
      ],
    );
  });

  it('does not apply a group deletion when the intent audit cannot be saved', async () => {
    create.rejects(new Error('private database failure'));
    const response = await fetch(`${base}/groups/${randomUUID()}`, {
      method: 'DELETE',
    });
    assert.equal(response.status, 503);
    assert.equal(backend.calls.length, 0);
  });

  it('refuses malformed access policies and membership fields before audit or forwarding', async () => {
    const group = randomUUID();
    for (const [method, path, body] of [
      [
        'PUT',
        `/groups/${group}/access`,
        { defaultAllow: true, revision: 0.5, rules: [] },
      ],
      [
        'PUT',
        `/groups/${group}/access`,
        {
          defaultAllow: true,
          rules: [{ ref: 'apps/private\nsecret', allow: true }],
        },
      ],
      [
        'PUT',
        `/groups/${group}/access`,
        { defaultAllow: true, rules: [{ ref: 'apps/source', allow: 'yes' }] },
      ],
      ['POST', `/groups/${group}/members/add`, { userIds: { $ne: null } }],
      [
        'POST',
        `/groups/${group}/members/add`,
        { userIds: [actor, { $ne: null }] },
      ],
      ['POST', '/groups', { name: { $ne: null } }],
    ] as const) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      assert.ok(!(await response.text()).includes('secret'));
    }
    assert.equal(create.callCount, 0);
    assert.equal(backend.calls.length, 0);
  });
});
