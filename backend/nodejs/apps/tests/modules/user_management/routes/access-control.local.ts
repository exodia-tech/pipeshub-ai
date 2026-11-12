/** Loopback-only development fixture server. Never connects to production data. */
import 'reflect-metadata';
import express from 'express';
import { request } from 'node:http';
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
import { AuthenticatedUserRequest } from '../../../../src/libs/middlewares/types';
import { getRecordBuffer } from '../../../../src/modules/knowledge_base/controllers/kb_controllers';

async function main() {
  if (process.env.AUDIT_TEST_MONGO_URI !== 'mongodb://127.0.0.1:55844')
    throw new Error('Local fixture database required');
  const backend = 'http://127.0.0.1:59093';
  const secret = 'local-only-test-secret-with-enough-length';
  const seeded = await fetch(`${backend}/test/demo`, {
    method: 'POST',
    headers: { 'x-exodia-test': 'local-synthetic-only' },
  });
  if (!seeded.ok) throw new Error('Could not seed disposable graph');
  const ids = (await seeded.json()) as {
    org: string;
    admin: string;
    member: string;
    group: string;
  };
  await mongoose.connect(process.env.AUDIT_TEST_MONGO_URI, {
    dbName: 'exodia_access_local',
  });
  for (const [id, name, role] of [
    [ids.admin, 'Alex Example', 'admin'],
    [ids.member, 'Sam Example', 'member'],
  ]) {
    await mongoose.connection.collection('users').updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      {
        $set: {
          orgId: new mongoose.Types.ObjectId(ids.org),
          fullName: name,
          email: `${role}@example.invalid`,
          slug: `local-${role}`,
          role,
          isDeleted: false,
          isActive: true,
        },
      },
      { upsert: true },
    );
  }
  const container = new Container();
  container
    .bind<AuthMiddleware>('AuthMiddleware')
    .toConstantValue(
      new AuthMiddleware(
        Logger.getInstance(),
        new AuthTokenService(secret, secret),
      ),
    );
  container
    .bind('AppConfig')
    .toConstantValue({ connectorBackend: backend, scopedJwtSecret: secret });
  const app = express();
  app.use((req, res, next) => {
    if (
      ![
        '127.0.0.1:4572',
        'localhost:4572',
        '127.0.0.1:4573',
        'localhost:4573',
      ].includes(req.headers.host ?? '') ||
      (req.headers.origin &&
        ![
          'http://127.0.0.1:4572',
          'http://localhost:4572',
          'http://127.0.0.1:4573',
          'http://localhost:4573',
        ].includes(req.headers.origin))
    ) {
      res.sendStatus(403);
      return;
    }
    next();
  });
  app.use(express.json());
  app.use(requestContextMiddleware);
  app.use('/api/v1/access-groups', createAccessGroupsRouter(container));
  app.use('/api/v1/audit', createAuditRouter(container));
  app.use(
    '/api/v1/conversations',
    fixtureChat(container.get<AuthMiddleware>('AuthMiddleware'), backend),
  );
  app.get('/api/v1/configurationManager/ai-models/available/llm', (_req, res) =>
    res.json({
      status: 'success',
      models: [
        {
          modelType: 'llm',
          provider: 'fixture',
          modelName: 'local-fixture',
          modelKey: 'local-fixture',
          isMultimodal: false,
          isReasoning: false,
          isDefault: true,
          modelFriendlyName: 'Local fixture responder · no external AI',
        },
      ],
    }),
  );
  app.get(['/api/v1/health', '/api/v1/health/services'], async (_req, res) => {
    try {
      await mongoose.connection.db!.admin().ping();
      const graphHealth = await fetch(`${backend}/test/health`, {
        headers: { 'x-exodia-test': 'local-synthetic-only' },
        signal: AbortSignal.timeout(3000),
      });
      if (!graphHealth.ok) throw new Error('Fixture graph unavailable');
      res.json({
        status: 'healthy',
        fixture: true,
        services: { query: 'healthy', connector: 'healthy' },
      });
    } catch {
      res.status(503).json({ status: 'unhealthy', fixture: true });
    }
  });
  app.get('/local/start', (req, res) => {
    const member = req.query.as === 'member';
    const token = jwt.sign(
      {
        userId: member ? ids.member : ids.admin,
        orgId: ids.org,
        role: member ? 'member' : 'admin',
      },
      secret,
      { expiresIn: '12h' },
    );
    res.setHeader('Cache-Control', 'no-store');
    res
      .type('html')
      .send(
        `<script>localStorage.setItem('jwt_access_token',${JSON.stringify(token)});location.replace(${JSON.stringify(req.query.view === 'chat' ? '/chat/' : '/workspace/groups/')})</script>`,
      );
  });
  app.get('/api/v1/users', (_req, res) =>
    res.json({
      users: [
        {
          id: ids.member,
          userId: ids.member,
          name: 'Sam Example',
          email: 'member@example.invalid',
          isActive: true,
          hasLoggedIn: true,
          profilePicture: null,
        },
        {
          id: ids.admin,
          userId: ids.admin,
          name: 'Alex Example',
          email: 'admin@example.invalid',
          isActive: true,
          hasLoggedIn: true,
          profilePicture: null,
        },
      ],
      pagination: { totalCount: 2 },
    }),
  );
  app.post('/api/v1/users/by-ids', async (req, res) => {
    const requested = Array.isArray(req.body.userIds)
      ? req.body.userIds.filter(
          (id: unknown) => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id),
        )
      : [];
    const users = await mongoose.connection
      .collection('users')
      .find({
        _id: {
          $in: requested.map((id: string) => new mongoose.Types.ObjectId(id)),
        },
        orgId: new mongoose.Types.ObjectId(ids.org),
      })
      .project({ fullName: 1, email: 1, hasLoggedIn: 1 })
      .toArray();
    res.json(users);
  });
  app.get('/api/v1/users/:id', (req, res) => {
    const admin = req.params.id === ids.admin;
    res.json({
      _id: req.params.id,
      userId: req.params.id,
      firstName: admin ? 'Alex' : 'Sam',
      lastName: 'Example',
      fullName: admin ? 'Alex Example' : 'Sam Example',
      email: `${admin ? 'admin' : 'member'}@example.invalid`,
      role: admin ? 'admin' : 'member',
      hasLoggedIn: true,
    });
  });
  app.get('/api/v1/org', (_req, res) =>
    res.json({ _id: ids.org, registeredName: 'EXODIA — local fixtures' }),
  );
  app.get('/api/v1/org/logo', (_req, res) => res.sendStatus(204));
  app.get('/api/v1/chat/speech/capabilities', (_req, res) =>
    res.json({ tts: null, stt: null }),
  );
  app.get('/api/v1/org/exists', (_req, res) => res.json({ exists: true }));
  app.get('/api/v1/userGroups', (_req, res) => res.json([]));
  app.get('/api/v1/userGroups/users/:id', (_req, res) => res.json([]));
  app.get(
    '/api/v1/configurationManager/platform/feature-flags/effective',
    (_req, res) => res.json({ featureFlags: {} }),
  );
  app.get(
    [
      '/api/v1/knowledgeBase/knowledge-hub/nodes',
      '/api/v1/knowledgeBase/knowledge-hub/nodes/:type/:id',
    ],
    container.get<AuthMiddleware>('AuthMiddleware').authenticate,
    async (req: AuthenticatedUserRequest, res, next) => {
      try {
        const limit = Number(req.query.limit ?? 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
          res.status(400).json({ error: 'Invalid local page size' });
          return;
        }
        const response = await fetch(`${backend}/test/browse`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-exodia-test': 'local-synthetic-only',
          },
          body: JSON.stringify({
            org: String(req.user!.orgId),
            member: String(req.user!.userId),
            parent: req.params.id,
            type: req.params.type,
            flattened: req.query.flattened === 'true',
            cursor:
              typeof req.query.cursor === 'string'
                ? req.query.cursor
                : undefined,
            q: typeof req.query.q === 'string' ? req.query.q : undefined,
            limit,
          }),
          signal: AbortSignal.timeout(30000),
        });
        const data = (await response.json()) as {
          success?: boolean;
          errorCode?: number;
        };
        res
          .status(
            response.ok
              ? data.success === false
                ? (data.errorCode ?? 500)
                : 200
              : response.status,
          )
          .json(data);
      } catch (error) {
        next(error);
      }
    },
  );
  app.get(
    '/api/v1/knowledgeBase/stream/record/:recordId',
    container.get<AuthMiddleware>('AuthMiddleware').authenticate,
    (req: AuthenticatedUserRequest, _res, next) => {
      req.headers.authorization = `Bearer ${jwt.sign({ userId: String(req.user!.userId), orgId: String(req.user!.orgId), scopes: ['record:content'] }, secret, { expiresIn: '5m' })}`;
      next();
    },
    getRecordBuffer(backend),
  );
  app.get(
    '/api/v1/knowledgeBase/record/:recordId',
    container.get<AuthMiddleware>('AuthMiddleware').authenticate,
    async (req: AuthenticatedUserRequest, res, next) => {
      try {
        const response = await fetch(`${backend}/test/record-detail`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-exodia-test': 'local-synthetic-only',
          },
          body: JSON.stringify({
            org: String(req.user!.orgId),
            member: String(req.user!.userId),
            id: String(req.params.recordId),
          }),
          signal: AbortSignal.timeout(15000),
        });
        res.status(response.status).json(await response.json());
      } catch (error) {
        next(error);
      }
    },
  );
  app.get(/^\/api\//, (req, res) => {
    if (req.path.includes('onboarding-status'))
      res.json({ status: 'configured' });
    else if (req.path.includes('conversations'))
      res.json({ conversations: [], pagination: { total: 0 } });
    else if (req.path.includes('agents'))
      res.json({ agents: [], pagination: { total: 0 } });
    else if (req.path.includes('connectors'))
      res.json({ connectors: [], total: 0 });
    else if (req.path.includes('demo'))
      res.json({ status: 'disabled', include: false, active: false });
    else {
      process.stdout.write(`Unsupported fixture API: ${req.path}\n`);
      res
        .status(404)
        .json({ error: 'This API is outside the isolated fixture workflow' });
    }
  });
  app.use((req, res) => {
    const upstream = request(
      {
        hostname: '127.0.0.1',
        port: 4571,
        path: req.originalUrl,
        method: req.method,
        headers: { ...req.headers, host: '127.0.0.1:4571' },
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.sendStatus(502);
      else res.end();
    });
    req.pipe(upstream);
  });
  app.use(
    (
      error: { statusCode?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      return res
        .status(error.statusCode || 500)
        .json({ error: error.message || 'Fixture service unavailable' });
    },
  );
  app.listen(4572, '127.0.0.1', () =>
    process.stdout.write(
      'Local access-control app: http://127.0.0.1:4572/local/start\n',
    ),
  );
  app.listen(4573, '127.0.0.1', () =>
    process.stdout.write(
      'Local member chat: http://127.0.0.1:4573/local/start?as=member&view=chat\n',
    ),
  );
}
main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
