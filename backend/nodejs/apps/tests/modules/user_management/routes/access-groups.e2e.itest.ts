import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
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
import { createAccessGroupsRouter } from '../../../../src/modules/user_management/routes/accessGroups.routes';
import { createAuditRouter } from '../../../../src/modules/audit/audit.routes';
import { fixtureChat } from './fixture-chat';
import { getRecordBuffer } from '../../../../src/modules/knowledge_base/controllers/kb_controllers';
import { AuthenticatedUserRequest } from '../../../../src/libs/middlewares/types';

describe('access groups across authenticated services', function () {
  let server: Server;
  let base: string;
  let token: string;
  let groupId: string | undefined;
  const org = new mongoose.Types.ObjectId().toHexString();
  const admin = new mongoose.Types.ObjectId().toHexString();
  const member = new mongoose.Types.ObjectId().toHexString();
  const foreign = new mongoose.Types.ObjectId().toHexString();
  const foreignOrg = new mongoose.Types.ObjectId().toHexString();
  const kb = randomUUID();
  const secret = 'local-only-test-secret-with-enough-length';
  const testServer = 'http://127.0.0.1:59093';
  const testHeaders = {
    'content-type': 'application/json',
    'x-exodia-test': 'local-synthetic-only',
  };
  async function graph(path: string, body: unknown): Promise<any> {
    const response = await fetch(`${testServer}/test/${path}`, {
      method: 'POST',
      headers: testHeaders,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, path);
    return response.json();
  }
  before(async function () {
    if (
      process.env.EXODIA_GROUP_E2E !== '1' ||
      process.env.AUDIT_TEST_MONGO_URI !== 'mongodb://127.0.0.1:55844'
    )
      this.skip();
    await mongoose.connect(process.env.AUDIT_TEST_MONGO_URI!, {
      dbName: `group_e2e_${Date.now()}`,
    });
    await mongoose.connection.collection('users').insertMany([
      {
        _id: new mongoose.Types.ObjectId(admin),
        orgId: new mongoose.Types.ObjectId(org),
        role: 'admin',
        email: 'admin@example.invalid',
        slug: 'admin-e2e',
        isDeleted: false,
      },
      {
        _id: new mongoose.Types.ObjectId(member),
        orgId: new mongoose.Types.ObjectId(org),
        role: 'member',
        email: 'member@example.invalid',
        slug: 'member-e2e',
        isDeleted: false,
      },
    ]);
    await graph('seed', { org, admin, member, foreign, foreignOrg, kb });
    token = jwt.sign({ userId: admin, orgId: org, role: 'admin' }, secret);
    const container = new Container();
    container
      .bind<AuthMiddleware>('AuthMiddleware')
      .toConstantValue(
        new AuthMiddleware(
          Logger.getInstance(),
          new AuthTokenService(secret, secret),
        ),
      );
    container.bind('AppConfig').toConstantValue({
      connectorBackend: testServer,
      scopedJwtSecret: secret,
    });
    const app = express();
    app.use(express.json());
    app.use(requestContextMiddleware);
    app.use('/access-groups', createAccessGroupsRouter(container));
    app.use('/audit', createAuditRouter(container));
    app.use(
      '/conversations',
      fixtureChat(container.get<AuthMiddleware>('AuthMiddleware'), testServer),
    );
    app.get(
      '/download/:recordId',
      container.get<AuthMiddleware>('AuthMiddleware').authenticate,
      (req: AuthenticatedUserRequest, _res, next) => {
        req.headers.authorization = `Bearer ${jwt.sign({ userId: String(req.user!.userId), orgId: String(req.user!.orgId), scopes: ['record:content'] }, secret, { expiresIn: '5m' })}`;
        next();
      },
      getRecordBuffer(testServer),
    );
    app.use((error: any, _req: any, res: any, _next: any) => {
      if (res.headersSent) return _next(error);
      return res.status(error.statusCode || 500).json({ error: error.message });
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    if (mongoose.connection.readyState) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
    if (process.env.EXODIA_GROUP_E2E === '1')
      await graph('cleanup', {
        ids: [
          org,
          admin,
          member,
          foreign,
          foreignOrg,
          kb,
          ...(groupId ? [groupId] : []),
        ],
      });
  });
  it('creates, shares, grants and revokes while recording admin actions', async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const created = await fetch(`${base}/access-groups`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: `Synthetic ${kb}`, description: 'Finance reference material' }),
    });
    assert.equal(created.status, 201);
    groupId = ((await created.json()) as { id: string }).id;
    const listed = await fetch(`${base}/access-groups`, { headers });
    const group = ((await listed.json()) as { groups: Array<{
      _key: string; description: string; createdAtTimestamp: number;
      createdByUser: { userId: string } | null;
    }> }).groups.find((item) => item._key === groupId);
    assert.equal(group?.description, 'Finance reference material');
    assert.equal(group?.createdByUser?.userId, admin);
    assert.ok(group && group.createdAtTimestamp > 0);
    const nameOnly = await fetch(`${base}/access-groups/${groupId}`, {
      method: 'PUT', headers, body: JSON.stringify({ name: `Synthetic ${kb}` }),
    });
    assert.equal(nameOnly.status, 200);
    const preserved = await fetch(`${base}/access-groups`, { headers });
    assert.equal(((await preserved.json()) as { groups: typeof group[] }).groups.find((item) => item?._key === groupId)?.description, 'Finance reference material');
    const invalidDescription = await fetch(`${base}/access-groups/${groupId}`, {
      method: 'PUT', headers, body: JSON.stringify({ name: `Synthetic ${kb}`, description: 'x'.repeat(2001) }),
    });
    assert.equal(invalidDescription.status, 400);
    const foreignList = await fetch(`${base}/access-groups`, { headers: {
      ...headers, authorization: `Bearer ${jwt.sign({ userId: foreign, orgId: foreignOrg, role: 'admin' }, secret)}`,
    } });
    assert.equal(foreignList.status, 401);
    const updated = await fetch(`${base}/access-groups/${groupId}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ name: `Synthetic ${kb}`, description: '' }),
    });
    assert.equal(updated.status, 200);
    const reread = await fetch(`${base}/access-groups`, { headers });
    const saved = ((await reread.json()) as { groups: typeof group[] }).groups.find((item) => item?._key === groupId);
    assert.equal(saved?.description, '');
    assert.equal(saved?.createdAtTimestamp, group.createdAtTimestamp);
    assert.equal(saved?.createdByUser?.userId, admin);
    await graph('share', { kb, admin, group: groupId });
    assert.deepEqual((await graph('access', { org, member })).ids, []);
    const denied = await fetch(`${base}/access-groups/${groupId}/members/add`, {
      method: 'POST',
      headers: {
        ...headers,
        authorization: `Bearer ${jwt.sign({ userId: member, orgId: org, role: 'member' }, secret)}`,
      },
      body: JSON.stringify({ userIds: [member] }),
    });
    assert.equal(denied.status, 403);
    const foreignAttempt = await fetch(
      `${base}/access-groups/${groupId}/members/add`,
      { method: 'POST', headers, body: JSON.stringify({ userIds: [foreign] }) },
    );
    assert.equal(foreignAttempt.status, 404);
    assert.deepEqual((await graph('access', { org, member })).ids, []);
    const added = await fetch(`${base}/access-groups/${groupId}/members/add`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userIds: [member] }),
    });
    assert.equal(added.status, 200);
    assert.deepEqual((await graph('access', { org, member })).ids, [kb]);
    const members = await fetch(`${base}/access-groups/${groupId}/members`, {
      headers,
    });
    assert.equal(
      ((await members.json()) as { members: Array<{ userId: string }> })
        .members[0].userId,
      member,
    );
    const removed = await fetch(
      `${base}/access-groups/${groupId}/members/remove`,
      { method: 'POST', headers, body: JSON.stringify({ userIds: [member] }) },
    );
    assert.equal(removed.status, 200);
    assert.deepEqual((await graph('access', { org, member })).ids, []);
    const audit = await fetch(
      `${base}/audit?group_id=${groupId}&outcome=success`,
      { headers },
    );
    const actions = (
      (await audit.json()) as { events: Array<{ action: string }> }
    ).events.map((event) => event.action);
    assert.ok(
      actions.includes('group.create') &&
        actions.includes('group.members.add') &&
        actions.includes('group.members.remove'),
    );
  });
  it('enforces a channel restriction on record and search reads and audits the change', async () => {
    const demo = (await graph('demo', {})) as {
      org: string;
      admin: string;
      member: string;
      group: string;
    };
    await mongoose.connection.collection('users').updateOne(
      { _id: new mongoose.Types.ObjectId(demo.admin) },
      {
        $set: {
          orgId: new mongoose.Types.ObjectId(demo.org),
          role: 'admin',
          email: 'fixture@example.invalid',
          slug: 'fixture-admin',
          isDeleted: false,
        },
      },
      { upsert: true },
    );
    await mongoose.connection.collection('users').updateOne(
      { _id: new mongoose.Types.ObjectId(demo.member) },
      {
        $set: {
          orgId: new mongoose.Types.ObjectId(demo.org),
          role: 'member',
          email: 'fixture-member@example.invalid',
          slug: 'fixture-member',
          isDeleted: false,
        },
      },
      { upsert: true },
    );
    const headers = {
      authorization: `Bearer ${jwt.sign({ userId: demo.admin, orgId: demo.org, role: 'admin' }, secret)}`,
      'content-type': 'application/json',
    };
    const path = `${base}/access-groups/${demo.group}/access`;
    const initial = await fetch(path, { headers });
    assert.equal(initial.status, 200);
    const previous = (
      (await initial.json()) as {
        policy: { revision: number; defaultAllow: boolean; rules: unknown[] };
      }
    ).policy;
    try {
      let saved = await fetch(path, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          defaultAllow: false,
          revision: previous.revision,
          rules: [{ ref: 'recordGroups/demo-finance', allow: true }],
        }),
      });
      assert.equal(saved.status, 200);
      const stale = await fetch(path, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ ...previous, defaultAllow: true, rules: [] }),
      });
      assert.equal(stale.status, 409);
      const allowed = await graph('authorized-records', {
        org: demo.org,
        member: demo.member,
      });
      assert.deepEqual(allowed.records, ['demo-finance-record']);
      assert.deepEqual(allowed.searchRecords, ['demo-finance-record']);
      assert.deepEqual(
        (await graph('chat-context', { org: demo.org, member: demo.member }))
          .contextRecordIds,
        ['demo-finance-record'],
      );
      const memberHeaders = {
        authorization: `Bearer ${jwt.sign({ userId: demo.member, orgId: demo.org, role: 'member' }, secret)}`,
        'content-type': 'application/json',
      };
      const reply = await fetch(`${base}/conversations/stream`, {
        method: 'POST',
        headers: memberHeaders,
        body: JSON.stringify({ query: 'Show finance' }),
      });
      assert.equal(reply.status, 200);
      const stream = await reply.text();
      assert.ok(stream.includes('synthetic quarterly budget review'));
      assert.ok(!stream.includes('LEADERSHIP_PRIVATE_CANARY'));
      assert.ok(stream.includes('RUN_FINISHED'));
      const frames = stream
        .trim()
        .split('\n\n')
        .map((frame) => JSON.parse(frame.replace(/^data: /, '')));
      const conversationId = frames.find(
        (frame) =>
          frame.type === 'CUSTOM' && frame.name === 'conversation_created',
      ).value.conversationId;
      const download = await fetch(`${base}/download/demo-finance-record`, {
        headers: memberHeaders,
      });
      assert.equal(download.status, 200);
      assert.ok(
        (await download.text()).includes('synthetic quarterly budget review'),
      );
      const privateDownload = await fetch(
        `${base}/download/demo-private-record`,
        { headers: memberHeaders },
      );
      assert.equal(privateDownload.status, 404);
      assert.ok(
        !(await privateDownload.text()).includes('LEADERSHIP_PRIVATE_CANARY'),
      );
      assert.equal(
        (await fetch(`${base}/conversations/${conversationId}`, { headers }))
          .status,
        404,
      );
      const browsing = await graph('browse', {
        org: demo.org,
        member: demo.member,
        parent: 'demo-slack',
        type: 'app',
      });
      assert.equal(browsing.success, true);
      assert.deepEqual(
        browsing.items.map((item: { id: string }) => item.id),
        ['demo-finance'],
      );
      const deniedFolder = await graph('browse', {
        org: demo.org,
        member: demo.member,
        parent: 'demo-general',
        type: 'recordGroup',
      });
      assert.equal(deniedFolder.success, false);
      assert.equal(deniedFolder.errorCode, 404);
      const allRecords = await graph('browse', {
        org: demo.org,
        member: demo.member,
        flattened: true,
        limit: 1,
      });
      assert.equal(allRecords.success, true);
      assert.ok(
        allRecords.items.every((item: { id: string }) =>
          ['demo-finance', 'demo-finance-record', 'demo-slack'].includes(
            item.id,
          ),
        ),
      );
      const tree = await fetch(
        `${base}/access-groups/${demo.group}/resources?parent=${encodeURIComponent('apps/demo-slack')}`,
        { headers },
      );
      assert.equal(tree.status, 200);
      const nodes = (await tree.json()) as {
        nodes: Array<{
          name: string;
          allowed: boolean;
          readableMembers: number;
        }>;
      };
      assert.equal(
        nodes.nodes.find((node) => node.name === '#finance')?.readableMembers,
        1,
      );
      assert.equal(
        nodes.nodes.find((node) => node.name === '#leadership-private')
          ?.readableMembers,
        0,
      );
      saved = await fetch(path, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          defaultAllow: false,
          revision: previous.revision + 1,
          rules: [
            { ref: 'recordGroups/demo-finance', allow: true },
            { ref: 'records/demo-finance-record', allow: false },
          ],
        }),
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(
        (
          await graph('authorized-records', {
            org: demo.org,
            member: demo.member,
          })
        ).records,
        [],
      );
      assert.deepEqual(
        (await graph('chat-context', { org: demo.org, member: demo.member }))
          .contextRecordIds,
        [],
      );
      assert.equal(
        (
          await fetch(`${base}/download/demo-finance-record`, {
            headers: memberHeaders,
          })
        ).status,
        404,
      );
      const deniedAudit = await fetch(
        `${base}/audit?action=record.download.start&outcome=denied&resource_id=demo-finance-record`,
        { headers },
      );
      assert.equal(deniedAudit.status, 200);
      assert.ok(
        ((await deniedAudit.json()) as { events: unknown[] }).events.length > 0,
      );
      const history = await fetch(`${base}/conversations/${conversationId}`, {
        headers: memberHeaders,
      });
      assert.equal(history.status, 200);
      const historical = await history.text();
      assert.ok(!historical.includes('synthetic quarterly budget review'));
      const hiddenHistory = JSON.parse(historical) as {
        messages: Array<{ answerHidden?: { reason?: string } }>;
      };
      assert.ok(hiddenHistory.messages.some((message) =>
        message.answerHidden?.reason === 'no_longer_accessible',
      ));
      saved = await fetch(path, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          defaultAllow: false,
          revision: previous.revision + 2,
          rules: [{ ref: 'records/demo-documents', allow: true }],
        }),
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(
        (
          await graph('authorized-records', {
            org: demo.org,
            member: demo.member,
          })
        ).records,
        ['demo-budget'],
      );
      assert.deepEqual(
        (await graph('chat-context', { org: demo.org, member: demo.member }))
          .contextRecordIds,
        ['demo-budget'],
      );
      const folders = await fetch(
        `${base}/access-groups/${demo.group}/resources?parent=${encodeURIComponent('recordGroups/demo-projects')}`,
        { headers },
      );
      const folderRows = (await folders.json()) as {
        nodes: Array<{ name: string }>;
      };
      assert.ok(folderRows.nodes.some((node) => node.name === 'Documents'));
      assert.ok(
        !folderRows.nodes.some((node) => node.name === 'Budget Q4.txt'),
      );
      const audit = await fetch(
        `${base}/audit?group_id=${demo.group}&action=group.access.change&outcome=success`,
        { headers },
      );
      assert.equal(audit.status, 200);
      const events = (
        (await audit.json()) as {
          events: Array<{
            resource_policy?: {
              default_allow: boolean;
              rules: Array<{ resource_ref: string; allow: boolean }>;
            };
          }>;
        }
      ).events;
      assert.ok(events.length >= 3);
      assert.ok(
        events.some((event) =>
          event.resource_policy?.rules.some(
            (rule) =>
              rule.resource_ref === 'records/demo-finance-record' &&
              !rule.allow,
          ),
        ),
      );
    } finally {
      const latest = (
        (await (await fetch(path, { headers })).json()) as {
          policy: { revision: number };
        }
      ).policy;
      const restored = await fetch(path, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ ...previous, revision: latest.revision }),
      });
      assert.equal(restored.status, 200);
    }
  });
  it('accepts exactly one simultaneous save for a policy revision', async () => {
    const demo = (await graph('demo', {})) as {
      org: string;
      admin: string;
      group: string;
    };
    const headers = {
      authorization: `Bearer ${jwt.sign({ userId: demo.admin, orgId: demo.org, role: 'admin' }, secret)}`,
      'content-type': 'application/json',
    };
    const path = `${base}/access-groups/${demo.group}/access`;
    const { policy } = (await (await fetch(path, { headers })).json()) as {
      policy: { revision: number; defaultAllow: boolean; rules: unknown[] };
    };
    const responses = await Promise.all(
      [0, 1].map(() =>
        fetch(path, { method: 'PUT', headers, body: JSON.stringify(policy) }),
      ),
    );
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );
    const current = (await (await fetch(path, { headers })).json()) as {
      policy: typeof policy;
    };
    assert.deepEqual(current.policy, {
      ...policy,
      revision: policy.revision + 1,
    });
  });
});
