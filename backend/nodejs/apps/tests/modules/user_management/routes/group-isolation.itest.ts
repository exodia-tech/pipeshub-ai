import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import express from 'express';
import { Container } from 'inversify';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { AuthMiddleware } from '../../../../src/libs/middlewares/auth.middleware';
import { requestContextMiddleware } from '../../../../src/libs/middlewares/request.context';
import { AuthTokenService } from '../../../../src/libs/services/authtoken.service';
import { Logger } from '../../../../src/libs/services/logger.service';
import { UserGroupController } from '../../../../src/modules/user_management/controller/userGroups.controller';
import { createUserGroupRouter } from '../../../../src/modules/user_management/routes/userGroups.routes';
import { createAuditRouter } from '../../../../src/modules/audit/audit.routes';
import { createAccessGroupsRouter } from '../../../../src/modules/user_management/routes/accessGroups.routes';
import { createKBPermission, getRecordBuffer } from '../../../../src/modules/knowledge_base/controllers/kb_controllers';
import { updateKBPermission, removeKBPermission } from '../../../../src/modules/knowledge_base/controllers/kb_controllers';

describe('group membership API isolation', function () {
  let server: Server;
  let connectorServer: Server;
  let shareCalls = 0;
  let downloadCalls = 0;
  let base: string;
  let token: string;
  let foreignToken: string;
  let memberToken: string;
  const org = new mongoose.Types.ObjectId();
  const foreignOrg = new mongoose.Types.ObjectId();
  const admin = new mongoose.Types.ObjectId();
  const foreign = new mongoose.Types.ObjectId();
  const member = new mongoose.Types.ObjectId();
  const foreignAdmin = new mongoose.Types.ObjectId();
  const group = new mongoose.Types.ObjectId();
  before(async function () {
    if (!process.env.AUDIT_TEST_MONGO_URI) this.skip();
    await mongoose.connect(process.env.AUDIT_TEST_MONGO_URI!, {
      dbName: `group_isolation_${Date.now()}`,
    });
    const secret = 'local-only-test-secret-with-enough-length';
    token = jwt.sign(
      { userId: String(admin), orgId: String(org), role: 'admin' },
      secret,
    );
    foreignToken = jwt.sign(
      {
        userId: String(foreignAdmin),
        orgId: String(foreignOrg),
        role: 'admin',
      },
      secret,
    );
    memberToken = jwt.sign(
      { userId: String(member), orgId: String(org), role: 'member' },
      secret,
    );
    const container = new Container();
    const connector = express();
    connector.use(express.json());
    connector.get('/api/v1/entity/access-groups', (req, res) => {
      const claims = jwt.verify(
        (req.headers.authorization ?? '').replace(/^Bearer /, ''),
        secret,
      ) as jwt.JwtPayload;
      assert.equal(claims.orgId, String(org));
      res.json({
        groups: [
          { _key: '5fdbb18a-9881-4d77-890f-28170c2fef12', name: 'Example' },
        ],
      });
    });
    connector.post('/api/v1/kb/:id/permissions', (req, res) => {
      shareCalls++;
      if (req.body.userIds.includes(String(foreign))) return res.status(403).json({ detail: 'denied' });
      return res.json({ success: true });
    });
    connector.put('/api/v1/kb/:id/permissions', (_req, res) => res.json({ userIds: [], teamIds: [], newRole: 'READER' }));
    connector.delete('/api/v1/kb/:id/permissions', (_req, res) => res.json({ userIds: [], teamIds: [] }));
    connector.get('/api/v1/stream/record/:id', (_req, res) => { downloadCalls++; res.type('text/plain').send('synthetic document bytes'); });
    connector.post('/api/v1/entity/access-groups', (req, res) => {
      const claims = jwt.verify(
        (req.headers.authorization ?? '').replace(/^Bearer /, ''),
        secret,
      ) as jwt.JwtPayload;
      assert.deepEqual(claims.scopes, ['access-group:manage']);
      assert.equal(claims.orgId, String(org));
      res.status(201).json({ id: '5fdbb18a-9881-4d77-890f-28170c2fef12' });
    });
    connector.post('/api/v1/entity/access-groups/:id/members', (req, res) => {
      const claims = jwt.verify(
        (req.headers.authorization ?? '').replace(/^Bearer /, ''),
        secret,
      ) as jwt.JwtPayload;
      assert.equal(claims.orgId, String(org));
      if (req.body.userIds.includes(String(foreign)))
        return res.status(404).json({ error: 'not found' });
      return res.json({ success: true });
    });
    connector.get('/api/v1/entity/access-groups/:id/members', (req, res) => {
      const claims = jwt.verify(
        (req.headers.authorization ?? '').replace(/^Bearer /, ''),
        secret,
      ) as jwt.JwtPayload;
      assert.equal(claims.orgId, String(org));
      res.json({ members: [{ userId: String(member) }], memberCount: 1 });
    });
    connector.put('/api/v1/entity/access-groups/:id', (_req, res) =>
      res.json({ success: true }),
    );
    connector.delete('/api/v1/entity/access-groups/:id', (_req, res) =>
      res.json({ success: true }),
    );
    connectorServer = await new Promise<Server>((resolve) => {
      const s = connector.listen(0, '127.0.0.1', () => resolve(s));
    });
    container.bind('AppConfig').toConstantValue({
      connectorBackend: `http://127.0.0.1:${(connectorServer.address() as AddressInfo).port}`,
      scopedJwtSecret: secret,
    });
    container
      .bind<AuthMiddleware>('AuthMiddleware')
      .toConstantValue(
        new AuthMiddleware(
          Logger.getInstance(),
          new AuthTokenService(secret, secret),
        ),
      );
    container
      .bind<UserGroupController>('UserGroupController')
      .toConstantValue(new UserGroupController());
    const app = express();
    app.use(express.json());
    app.use(requestContextMiddleware);
    app.use('/userGroups', createUserGroupRouter(container));
    app.use('/audit', createAuditRouter(container));
    app.use('/access-groups', createAccessGroupsRouter(container));
    app.post('/collections/:kbId/permissions', container.get<AuthMiddleware>('AuthMiddleware').authenticate,
      createKBPermission(container.get('AppConfig')));
    app.put('/collections/:kbId/permissions', container.get<AuthMiddleware>('AuthMiddleware').authenticate,
      updateKBPermission(container.get('AppConfig')));
    app.delete('/collections/:kbId/permissions', container.get<AuthMiddleware>('AuthMiddleware').authenticate,
      removeKBPermission(container.get('AppConfig')));
    app.get('/records/:recordId/download', container.get<AuthMiddleware>('AuthMiddleware').authenticate,
      getRecordBuffer((container.get('AppConfig') as { connectorBackend: string }).connectorBackend));
    app.use((err: any, _req: any, res: any, _next: any) =>
      res.status(err.statusCode || 500).json({ error: err.message }),
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    shareCalls = 0;
    downloadCalls = 0;
    await mongoose.connection.collection('users').deleteMany({});
    await mongoose.connection.collection('userGroups').deleteMany({});
    await mongoose.connection.collection('exodiaAuditEvents').deleteMany({});
    await mongoose.connection.collection('users').insertMany([
      {
        _id: admin,
        orgId: org,
        email: 'admin@example.invalid',
        slug: 'admin-test',
        role: 'admin',
        isDeleted: false,
      },
      {
        _id: foreign,
        orgId: foreignOrg,
        email: 'other@example.invalid',
        slug: 'foreign-test',
        role: 'member',
        isDeleted: false,
      },
      {
        _id: member,
        orgId: org,
        email: 'member@example.invalid',
        slug: 'member-test',
        role: 'member',
        isDeleted: false,
      },
      {
        _id: foreignAdmin,
        orgId: foreignOrg,
        email: 'foreign-admin@example.invalid',
        slug: 'foreign-admin-test',
        role: 'admin',
        isDeleted: false,
      },
    ]);
    await mongoose.connection.collection('userGroups').insertOne({
      _id: group,
      orgId: org,
      name: 'Private',
      type: 'custom',
      users: [],
      isDeleted: false,
    });
  });
  after(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    if (connectorServer)
      await new Promise<void>((resolve, reject) =>
        connectorServer.close((e) => (e ? reject(e) : resolve())),
      );
    if (mongoose.connection.readyState) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });
  it('refuses adding a person from a different organization', async () => {
    const response = await fetch(`${base}/userGroups/add-users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userIds: [String(foreign)],
        groupIds: [String(group)],
      }),
    });
    assert.equal(response.status, 404);
    const list = await fetch(`${base}/userGroups/${group}/users`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await list.json()) as { users: unknown[] };
    assert.deepEqual(body.users, []);
  });
  it('creates an access group through an audited admin-only gateway', async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const denied = await fetch(`${base}/access-groups`, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${memberToken}` },
      body: JSON.stringify({ name: 'Example' }),
    });
    assert.equal(denied.status, 403);
    const denial = await fetch(
      `${base}/audit?action=group.create&outcome=denied`,
      { headers },
    );
    const denialBody = (await denial.json()) as { events: unknown[] };
    assert.equal(denialBody.events.length, 1);
    const created = await fetch(`${base}/access-groups`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Example' }),
    });
    assert.equal(created.status, 201);
    const audit = await fetch(
      `${base}/audit?action=group.create&outcome=success`,
      { headers },
    );
    const body = (await audit.json()) as {
      events: Array<{ group_ids: string[] }>;
    };
    assert.deepEqual(body.events[0].group_ids, [
      '5fdbb18a-9881-4d77-890f-28170c2fef12',
    ]);
  });
  it('audits changes to graph-backed group membership', async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const id = '5fdbb18a-9881-4d77-890f-28170c2fef12';
    for (const operation of ['add', 'remove']) {
      const response = await fetch(
        `${base}/access-groups/${id}/members/${operation}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ userIds: [String(member)] }),
        },
      );
      assert.equal(response.status, 200);
      const audit = await fetch(
        `${base}/audit?action=group.members.${operation}&outcome=success`,
        { headers },
      );
      const body = (await audit.json()) as {
        events: Array<{ group_ids: string[]; member_ids: string[] }>;
      };
      assert.deepEqual(body.events[0].group_ids, [id]);
      assert.deepEqual(body.events[0].member_ids, [String(member)]);
      const filtered = await fetch(
        `${base}/audit?group_id=${id}&action=group.members.${operation}&outcome=success`,
        { headers },
      );
      assert.equal(filtered.status, 200);
      const filteredBody = (await filtered.json()) as { events: unknown[] };
      assert.equal(filteredBody.events.length, 1);
    }
  });
  it('lists access groups only for authenticated administrators', async () => {
    const memberResponse = await fetch(`${base}/access-groups`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    assert.equal(memberResponse.status, 403);
    const response = await fetch(`${base}/access-groups`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { groups: Array<{ name: string }> };
    assert.equal(body.groups[0].name, 'Example');
  });
  it('audits collection sharing without recording document content', async () => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const response = await fetch(`${base}/collections/collection-id/permissions`, {
      method: 'POST', headers, body: JSON.stringify({ userIds: [String(member)], role: 'READER' }),
    });
    assert.equal(response.status, 201);
    const audit = await fetch(`${base}/audit?action=collection.permission.grant&outcome=success&resource_id=collection-id`, { headers });
    const body = (await audit.json()) as { events: Array<{ resource_id: string }> };
    assert.equal(body.events[0].resource_id, 'collection-id');
    const other = await fetch(`${base}/audit?action=collection.permission.grant&outcome=success&resource_id=other-id`, { headers });
    const otherBody = (await other.json()) as { events: unknown[] };
    assert.equal(otherBody.events.length, 0);
    for (const [method, action] of [['PUT', 'collection.permission.change'], ['DELETE', 'collection.permission.revoke']]) {
      const changed = await fetch(`${base}/collections/collection-id/permissions`, {
        method, headers, body: JSON.stringify({ userIds: [String(member)], role: 'READER' }),
      });
      assert.equal(changed.status, 200);
      const found = await fetch(`${base}/audit?action=${action}&outcome=success`, { headers });
      const events = (await found.json()) as { events: Array<{ resource_id: string }> };
      assert.equal(events.events[0].resource_id, 'collection-id');
    }
  });
  it('does not change collection sharing when audit intent cannot be stored', async () => {
    const db = mongoose.connection.db!;
    await mongoose.model('exodiaAuditEvent').init();
    await db.command({ collMod: 'exodiaAuditEvents', validator: { $jsonSchema: { properties: { outcome: { enum: ['success'] } } } } });
    try {
      const response = await fetch(`${base}/collections/collection-id/permissions`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ userIds: [String(member)], role: 'READER' }),
      });
      assert.equal(response.status, 503);
      assert.equal(shareCalls, 0);
    } finally { await db.command({ collMod: 'exodiaAuditEvents', validator: {} }); }
  });
  it('records denied collection permission changes', async () => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const response = await fetch(`${base}/collections/collection-id/permissions`, {
      method: 'POST', headers, body: JSON.stringify({ userIds: [String(foreign)], role: 'READER' }),
    });
    assert.equal(response.status, 403);
    const audit = await fetch(`${base}/audit?action=collection.permission.grant&outcome=denied`, { headers });
    const body = (await audit.json()) as { events: Array<{ resource_id: string }> };
    assert.equal(body.events[0].resource_id, 'collection-id');
  });
  it('records a document stream start without storing document content', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const response = await fetch(`${base}/records/record-id/download`, { headers });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'synthetic document bytes');
    const audit = await fetch(`${base}/audit?action=record.download.start&outcome=success`, { headers });
    const body = (await audit.json()) as { events: Array<{ resource_id: string }> };
    assert.equal(body.events[0].resource_id, 'record-id');
    assert.equal(JSON.stringify(body).includes('synthetic document bytes'), false);
  });
  it('does not start a document stream when audit intent cannot be stored', async () => {
    const db = mongoose.connection.db!;
    await mongoose.model('exodiaAuditEvent').init();
    await db.command({ collMod: 'exodiaAuditEvents', validator: { $jsonSchema: { properties: { outcome: { enum: ['success'] } } } } });
    try {
      const response = await fetch(`${base}/records/record-id/download`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 503);
      assert.equal(downloadCalls, 0);
      assert.equal((await response.text()).includes('synthetic document bytes'), false);
    } finally { await db.command({ collMod: 'exodiaAuditEvents', validator: {} }); }
  });
  it('does not release document bytes when the stream-start audit cannot be stored', async () => {
    const db = mongoose.connection.db!;
    await mongoose.model('exodiaAuditEvent').init();
    await db.command({ collMod: 'exodiaAuditEvents', validator: { $jsonSchema: { properties: { outcome: { enum: ['intent'] } } } } });
    try {
      const response = await fetch(`${base}/records/record-id/download`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 503);
      assert.equal(downloadCalls, 1);
      assert.equal((await response.text()).includes('synthetic document bytes'), false);
    } finally { await db.command({ collMod: 'exodiaAuditEvents', validator: {} }); }
  });
  it('allows only administrators to inspect access group members', async () => {
    const path = `${base}/access-groups/5fdbb18a-9881-4d77-890f-28170c2fef12/members`;
    const forbidden = await fetch(path, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    assert.equal(forbidden.status, 403);
    const response = await fetch(path, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      members: Array<{ userId: string }>;
    };
    assert.equal(body.members[0].userId, String(member));
  });
  it('audits access group renames and deletion', async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const id = '5fdbb18a-9881-4d77-890f-28170c2fef12';
    for (const [method, action] of [
      ['PUT', 'group.rename'],
      ['DELETE', 'group.delete'],
    ]) {
      const response = await fetch(`${base}/access-groups/${id}`, {
        method,
        headers,
        ...(method === 'PUT'
          ? { body: JSON.stringify({ name: 'Renamed' }) }
          : {}),
      });
      assert.equal(response.status, 200);
      const audit = await fetch(
        `${base}/audit?action=${action}&outcome=success&group_id=${id}`,
        { headers },
      );
      const body = (await audit.json()) as { events: unknown[] };
      assert.equal(body.events.length, 1);
    }
  });
  it('does not partially add valid members when a request includes a foreign member', async () => {
    const response = await fetch(`${base}/userGroups/add-users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userIds: [String(member), String(foreign)],
        groupIds: [String(group)],
      }),
    });
    assert.equal(response.status, 404);
    const list = await fetch(`${base}/userGroups/${group}/users`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await list.json()) as { users: unknown[] };
    assert.deepEqual(body.users, []);
  });
  it('records a successful group membership change for authorized administrators', async () => {
    const response = await fetch(`${base}/userGroups/add-users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userIds: [String(member)],
        groupIds: [String(group)],
      }),
    });
    assert.equal(response.status, 200);
    const audit = await fetch(`${base}/audit`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(audit.status, 200);
    const body = (await audit.json()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.ok(
      body.events.some(
        (event) =>
          event.action === 'group.members.add' &&
          event.outcome === 'success' &&
          event.actor_id === String(admin),
      ),
    );
    assert.equal(
      JSON.stringify(body).includes('member@example.invalid'),
      false,
    );
  });

  it('restricts audit history to administrators in the event organization', async () => {
    const add = await fetch(`${base}/userGroups/add-users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userIds: [String(member)],
        groupIds: [String(group)],
      }),
    });
    assert.equal(add.status, 200);
    const memberResponse = await fetch(`${base}/audit`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    assert.equal(memberResponse.status, 403);
    const foreignResponse = await fetch(`${base}/audit?org_id=${org}`, {
      headers: { authorization: `Bearer ${foreignToken}` },
    });
    assert.equal(foreignResponse.status, 200);
    const foreignBody = (await foreignResponse.json()) as { events: unknown[] };
    assert.deepEqual(foreignBody.events, []);
    const anonymous = await fetch(`${base}/audit`);
    assert.equal(anonymous.status, 401);
  });

  it('records administrators reading the audit history without exposing query contents', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const first = await fetch(`${base}/audit?limit=1`, { headers });
    assert.equal(first.status, 200);
    const second = await fetch(
      `${base}/audit?action=audit.read&outcome=success`,
      { headers },
    );
    assert.equal(second.status, 200);
    const body = (await second.json()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].actor_id, String(admin));
    assert.equal(body.events[0].action, 'audit.read');
    assert.equal(JSON.stringify(body.events[0]).includes('limit=1'), false);
  });

  it('records a current-page export separately from viewing the log', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const download = await fetch(`${base}/audit?export=true`, { headers });
    assert.equal(download.status, 200);
    const audit = await fetch(`${base}/audit?action=audit.export`, { headers });
    assert.equal(audit.status, 200);
    const body = (await audit.json()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].action, 'audit.export');
    assert.equal(body.events[0].actor_id, String(admin));
  });

  it('does not return audit history if the access event cannot be recorded', async () => {
    const db = mongoose.connection.db!;
    if (!(await db.listCollections({ name: 'exodiaAuditEvents' }).hasNext()))
      await db.createCollection('exodiaAuditEvents');
    await db.command({
      collMod: 'exodiaAuditEvents',
      validator: {
        $jsonSchema: { properties: { action: { enum: ['group.create'] } } },
      },
    });
    try {
      const response = await fetch(`${base}/audit`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 503);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.events, undefined);
      assert.match(String(body.error), /history cannot be shown/i);
    } finally {
      await db.command({ collMod: 'exodiaAuditEvents', validator: {} });
    }
  });

  it('records a successful removal and the member no longer appears in the group', async () => {
    const add = await fetch(`${base}/userGroups/add-users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userIds: [String(member)],
        groupIds: [String(group)],
      }),
    });
    assert.equal(add.status, 200);
    const response = await fetch(`${base}/userGroups/remove-users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userIds: [String(member)],
        groupIds: [String(group)],
      }),
    });
    assert.equal(response.status, 200);
    const list = await fetch(`${base}/userGroups/${group}/users`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const groupBody = (await list.json()) as { users: unknown[] };
    assert.deepEqual(groupBody.users, []);
    const audit = await fetch(`${base}/audit`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await audit.json()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.ok(
      body.events.some(
        (event) =>
          event.action === 'group.members.remove' &&
          event.outcome === 'success',
      ),
    );
  });

  it('audits creation of a custom group', async () => {
    const response = await fetch(`${base}/userGroups`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Finance', type: 'custom' }),
    });
    assert.equal(response.status, 201);
    const created = (await response.json()) as { _id: string };
    const audit = await fetch(`${base}/audit`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await audit.json()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.ok(
      body.events.some(
        (event) =>
          event.action === 'group.create' &&
          event.outcome === 'success' &&
          (event.group_ids as string[]).includes(created._id),
      ),
    );
  });
  it('audits a group rename and deletion', async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-request-id': 'group-change-request-123',
    };
    const rename = await fetch(`${base}/userGroups/${group}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ name: 'Renamed' }),
    });
    assert.equal(rename.status, 200);
    const remove = await fetch(`${base}/userGroups/${group}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(remove.status, 200);
    const audit = await fetch(`${base}/audit`, { headers });
    const body = (await audit.json()) as {
      events: Array<Record<string, unknown>>;
    };
    for (const action of ['group.rename', 'group.delete']) {
      assert.ok(
        body.events.some(
          (event) =>
            event.action === action &&
            event.outcome === 'success' &&
            event.request_id === 'group-change-request-123' &&
            (event.group_ids as string[]).includes(String(group)),
        ),
      );
    }
  });

  it('does not change membership when audit intent cannot be stored', async () => {
    const db = mongoose.connection.db!;
    if (!(await db.listCollections({ name: 'exodiaAuditEvents' }).hasNext())) {
      await db.createCollection('exodiaAuditEvents');
    }
    await db.command({
      collMod: 'exodiaAuditEvents',
      validator: { $jsonSchema: { required: ['test_field_never_written'] } },
    });
    try {
      const response = await fetch(`${base}/userGroups/add-users`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userIds: [String(member)],
          groupIds: [String(group)],
        }),
      });
      assert.equal(response.status, 503);
      const list = await fetch(`${base}/userGroups/${group}/users`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await list.json()) as { users: unknown[] };
      assert.deepEqual(body.users, []);
    } finally {
      await db.command({ collMod: 'exodiaAuditEvents', validator: {} });
    }
  });

  it('records the request correlation ID with the administrator action', async () => {
    const response = await fetch(`${base}/userGroups/add-users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-request-id': 'audit-test-request-123',
      },
      body: JSON.stringify({
        userIds: [String(member)],
        groupIds: [String(group)],
      }),
    });
    assert.equal(response.status, 200);
    const audit = await fetch(`${base}/audit`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await audit.json()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.ok(
      body.events.some(
        (event) =>
          event.action === 'group.members.add' &&
          event.outcome === 'success' &&
          event.request_id === 'audit-test-request-123',
      ),
    );
  });

  it('filters audit history by action without returning other events', async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const add = await fetch(`${base}/userGroups/add-users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userIds: [String(member)],
        groupIds: [String(group)],
      }),
    });
    assert.equal(add.status, 200);
    const remove = await fetch(`${base}/userGroups/remove-users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userIds: [String(member)],
        groupIds: [String(group)],
      }),
    });
    assert.equal(remove.status, 200);
    const audit = await fetch(`${base}/audit?action=group.members.remove`, {
      headers,
    });
    assert.equal(audit.status, 200);
    const body = (await audit.json()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.equal(body.events.length, 2);
    assert.ok(
      body.events.every((event) => event.action === 'group.members.remove'),
    );
  });

  it('records when a non-admin is denied a group membership change', async () => {
    const response = await fetch(`${base}/userGroups/add-users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userIds: [String(member)],
        groupIds: [String(group)],
      }),
    });
    assert.equal(response.status, 403);
    const audit = await fetch(`${base}/audit`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await audit.json()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.ok(
      body.events.some(
        (event) =>
          event.action === 'group.members.add' &&
          event.outcome === 'denied' &&
          event.actor_id === String(member),
      ),
    );
  });

  it('reports an uncertain outcome when only the completion audit write fails', async () => {
    const db = mongoose.connection.db!;
    if (!(await db.listCollections({ name: 'exodiaAuditEvents' }).hasNext()))
      await db.createCollection('exodiaAuditEvents');
    await db.command({
      collMod: 'exodiaAuditEvents',
      validator: {
        $jsonSchema: { properties: { outcome: { enum: ['intent'] } } },
      },
    });
    try {
      const response = await fetch(`${base}/userGroups/add-users`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userIds: [String(member)],
          groupIds: [String(group)],
        }),
      });
      assert.equal(response.status, 503);
      const error = (await response.json()) as { error: string };
      assert.match(error.error, /may have completed/i);
      const list = await fetch(`${base}/userGroups/${group}/users`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await list.json()) as { users: unknown[] };
      assert.equal(body.users.length, 1);
    } finally {
      await db.command({ collMod: 'exodiaAuditEvents', validator: {} });
    }
  });

  it('reports audit storage read failures as unavailable', async () => {
    const db = mongoose.connection.db!;
    await mongoose.model('exodiaAuditEvent').init();
    await db.collection('exodiaAuditEvents').insertOne({ org_id: String(org) });
    await db.collection('exodiaAuditEvents').rename('auditReadFailureSource');
    await db.createCollection('exodiaAuditEvents', {
      viewOn: 'auditReadFailureSource',
      pipeline: [{ $addFields: { error: { $divide: [1, 0] } } }],
    });
    try {
      const response = await fetch(`${base}/audit`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 503);
    } finally {
      await db.collection('exodiaAuditEvents').drop();
      await db.collection('auditReadFailureSource').rename('exodiaAuditEvents');
    }
  });

  it('pages audit history without duplicating or skipping events', async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const add = await fetch(`${base}/userGroups/add-users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userIds: [String(member)],
        groupIds: [String(group)],
      }),
    });
    assert.equal(add.status, 200);
    const first = await fetch(`${base}/audit?limit=1`, { headers });
    const page = (await first.json()) as {
      events: Array<{ id: string }>;
      next_cursor: string | null;
    };
    assert.equal(page.events.length, 1);
    assert.ok(page.next_cursor);
    const next = await fetch(
      `${base}/audit?limit=1&cursor=${encodeURIComponent(page.next_cursor!)}`,
      { headers },
    );
    const second = (await next.json()) as {
      events: Array<{ id: string }>;
      next_cursor: string | null;
    };
    assert.equal(second.events.length, 1);
    assert.notEqual(second.events[0].id, page.events[0].id);
    assert.equal(second.next_cursor, null);
  });

  it('filters audit history by actor, group, outcome and time', async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const add = await fetch(`${base}/userGroups/add-users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userIds: [String(member)],
        groupIds: [String(group)],
      }),
    });
    assert.equal(add.status, 200);
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const params = new URLSearchParams({
      actor_id: String(admin),
      group_id: String(group),
      outcome: 'success',
      from,
      to,
    });
    const audit = await fetch(`${base}/audit?${params}`, { headers });
    assert.equal(audit.status, 200);
    const body = (await audit.json()) as {
      events: Array<Record<string, unknown>>;
    };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].outcome, 'success');
  });
  it('finds audit events when identifiers use different hexadecimal casing', async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const add = await fetch(`${base}/userGroups/add-users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userIds: [String(member)],
        groupIds: [String(group).toUpperCase()],
      }),
    });
    assert.equal(add.status, 200);
    const params = new URLSearchParams({
      actor_id: String(admin).toUpperCase(),
      group_id: String(group),
      outcome: 'success',
    });
    const response = await fetch(`${base}/audit?${params}`, { headers });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { events: unknown[] };
    assert.equal(body.events.length, 1);
  });
  it('stores service agent events in the same administrator audit history', async () => {
    const service = jwt.sign(
      { orgId: String(org), userId: String(member), scopes: ['audit:write'] },
      'local-only-test-secret-with-enough-length', { expiresIn: '1m' },
    );
    const event = {
      event_id: 'f48120d4-1784-4f5c-bb0a-cea429d655a0',
      action: 'agent.tool', outcome: 'failed',
      agent_event: { run_id: 'run-1', trace_id: 'trace-1', agent_id: 'agent-1', tool_call_id: 'call-1', tool_name: 'fetch_record', model: 'fixture-model' },
    };
    const response = await fetch(`${base}/audit/internal/events`, {
      method: 'POST', headers: { authorization: `Bearer ${service}`, 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    assert.equal(response.status, 201);
    const read = await fetch(`${base}/audit?action=agent.tool&outcome=failed&actor_id=${member}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(read.status, 200);
    const body = await read.json() as { events: Array<Record<string, any>> };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].actor_id, String(member));
    assert.equal(body.events[0].operation_id, event.event_id);
    assert.deepEqual(body.events[0].agent_event, event.agent_event);
    const foreignRead = await fetch(`${base}/audit?action=agent.tool`, {
      headers: { authorization: `Bearer ${foreignToken}` },
    });
    assert.equal(foreignRead.status, 200);
    assert.deepEqual((await foreignRead.json() as { events: unknown[] }).events, []);
  });
  it('deduplicates concurrent agent-event replays without allowing history to be rewritten', async () => {
    const service = jwt.sign(
      { orgId: String(org), userId: String(member), scopes: ['audit:write'] },
      'local-only-test-secret-with-enough-length', { expiresIn: '1m' },
    );
    const event = {
      event_id: 'f48120d4-1784-4f5c-bb0a-cea429d655a0', action: 'agent.tool', outcome: 'success',
      agent_event: { run_id: 'run-1', trace_id: 'trace-1', agent_id: 'agent-1', tool_call_id: 'call-1', tool_name: 'fetch_record' },
    };
    const headers = { authorization: `Bearer ${service}`, 'content-type': 'application/json' };
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${base}/audit/internal/events`, { method: 'POST', headers, body: JSON.stringify(event) })));
    assert.deepEqual(responses.map((response) => response.status), Array(8).fill(201));
    const read = await fetch(`${base}/audit?action=agent.tool`, { headers: { authorization: `Bearer ${token}` } });
    const saved = (await read.json() as { events: Array<Record<string, unknown>> }).events;
    assert.equal(saved.length, 1);
    for (const changed of [
      { ...event, outcome: 'denied' },
      { ...event, agent_event: { ...event.agent_event, tool_name: 'delete_record' } },
    ]) {
      const response = await fetch(`${base}/audit/internal/events`, { method: 'POST', headers, body: JSON.stringify(changed) });
      assert.equal(response.status, 409);
    }
    const otherActor = jwt.sign({ orgId: String(org), userId: String(admin), scopes: ['audit:write'] },
      'local-only-test-secret-with-enough-length', { expiresIn: '1m' });
    const rewriteActor = await fetch(`${base}/audit/internal/events`, {
      method: 'POST', headers: { ...headers, authorization: `Bearer ${otherActor}` }, body: JSON.stringify(event),
    });
    assert.equal(rewriteActor.status, 409);
    const again = await fetch(`${base}/audit?action=agent.tool`, { headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual((await again.json() as { events: unknown[] }).events, saved);
  });
  it('keeps the same source event ID isolated between organizations', async () => {
    const event = { event_id: 'f48120d4-1784-4f5c-bb0a-cea429d655a0', action: 'agent.run', outcome: 'intent',
      agent_event: { run_id: 'run-1', trace_id: 'trace-1', agent_id: 'agent-1' } };
    for (const [organization, actor] of [[org, member], [foreignOrg, foreign]]) {
      const service = jwt.sign({ orgId: String(organization), userId: String(actor), scopes: ['audit:write'] },
        'local-only-test-secret-with-enough-length', { expiresIn: '1m' });
      const response = await fetch(`${base}/audit/internal/events`, { method: 'POST', headers: { authorization: `Bearer ${service}`, 'content-type': 'application/json' }, body: JSON.stringify(event) });
      assert.equal(response.status, 201);
    }
    for (const [credential, actor] of [[token, member], [foreignToken, foreign]]) {
      const response = await fetch(`${base}/audit?action=agent.run&export=true`, { headers: { authorization: `Bearer ${credential}` } });
      assert.equal(response.status, 200);
      const events = (await response.json() as { events: Array<{ actor_id: string }> }).events;
      assert.equal(events.length, 1);
      assert.equal(events[0].actor_id, String(actor));
    }
    const forbidden = await fetch(`${base}/audit?export=true`, { headers: { authorization: `Bearer ${memberToken}` } });
    assert.equal(forbidden.status, 403);
  });
  it('rejects client tokens, forged identity and content in agent audit ingestion', async () => {
    const claims = { orgId: String(org), userId: String(member), scopes: ['audit:write'] };
    const secret = 'local-only-test-secret-with-enough-length';
    const event = {
      event_id: 'f48120d4-1784-4f5c-bb0a-cea429d655a0', action: 'agent.run', outcome: 'intent',
      agent_event: { run_id: 'run-1', trace_id: 'trace-1', agent_id: 'agent-1' },
    };
    for (const credential of [token, memberToken, '',
      jwt.sign({ ...claims, scopes: ['storage:token'] }, secret, { expiresIn: '1m' }),
      jwt.sign(claims, secret, { expiresIn: -1 }), jwt.sign(claims, secret),
      jwt.sign({ ...claims, orgId: undefined }, secret, { expiresIn: '1m' }),
      jwt.sign({ ...claims, scopes: 'audit:write' }, secret, { expiresIn: '1m' }),
    ]) {
      const response = await fetch(`${base}/audit/internal/events`, {
        method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(event),
      });
      assert.equal(response.status, 401);
    }
    const headers = { authorization: `Bearer ${jwt.sign(claims, secret, { expiresIn: '1m' })}`, 'content-type': 'application/json' };
    for (const body of [
      { ...event, org_id: String(foreignOrg) }, { ...event, actor_id: String(admin) },
      { ...event, content: 'private document' }, { ...event, action: 'group.delete' },
      { ...event, outcome: 'invented' }, { ...event, action: 'agent.tool' },
      { ...event, agent_event: { ...event.agent_event, args: { token: 'secret' } } },
      { ...event, agent_event: { ...event.agent_event, tool_name: 'x'.repeat(257) } },
    ]) {
      const response = await fetch(`${base}/audit/internal/events`, { method: 'POST', headers, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
    const read = await fetch(`${base}/audit?action=agent.run`, { headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual((await read.json() as { events: unknown[] }).events, []);
  });
  it('does not acknowledge an agent event when Mongo rejects its write', async () => {
    const db = mongoose.connection.db!;
    await mongoose.model('exodiaAuditEvent').init();
    await db.command({ collMod: 'exodiaAuditEvents', validator: { $jsonSchema: { properties: { action: { enum: ['audit.read'] } } } } });
    try {
      const service = jwt.sign({ orgId: String(org), userId: String(member), scopes: ['audit:write'] },
        'local-only-test-secret-with-enough-length', { expiresIn: '1m' });
      const response = await fetch(`${base}/audit/internal/events`, {
        method: 'POST', headers: { authorization: `Bearer ${service}`, 'content-type': 'application/json' },
        body: JSON.stringify({ event_id: 'f48120d4-1784-4f5c-bb0a-cea429d655a0', action: 'agent.run', outcome: 'intent', agent_event: { run_id: 'run-1', trace_id: 'trace-1', agent_id: 'agent-1' } }),
      });
      assert.equal(response.status, 503);
    } finally { await db.command({ collMod: 'exodiaAuditEvents', validator: {} }); }
  });
  it('rejects malformed audit filters and ignores stale admin role claims', async () => {
    const staleAdmin = jwt.sign(
      { userId: String(member), orgId: String(org), role: 'admin' },
      'local-only-test-secret-with-enough-length',
    );
    const forbidden = await fetch(`${base}/audit`, {
      headers: { authorization: `Bearer ${staleAdmin}` },
    });
    assert.equal(forbidden.status, 403);
    const headers = { authorization: `Bearer ${token}` };
    for (const query of [
      'action=not-valid',
      'limit=0',
      'limit=101',
      'cursor=bad',
      'actor_id=bad',
      'outcome=other',
      'from=not-a-date',
    ]) {
      const response = await fetch(`${base}/audit?${query}`, { headers });
      assert.equal(response.status, 400, query);
    }
  });
});
