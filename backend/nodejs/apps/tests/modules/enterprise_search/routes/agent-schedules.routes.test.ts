import 'reflect-metadata';
import { asAccount } from '../../../../src/libs/context/orgContext';
import { strict as assert } from 'node:assert';
import express from 'express';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import sinon from 'sinon';
import { Container } from 'inversify';
import { AuthenticatedUserRequest } from '../../../../src/libs/middlewares/types';
import {
  createAgentScheduleRouter,
  agentScheduleInput,
} from '../../../../src/modules/enterprise_search/routes/agent-schedules.routes';
import { ScheduledAgentRuntime } from '../../../../src/modules/enterprise_search/services/scheduled-agent-runtime';
import { AgentSchedules } from '../../../../src/modules/enterprise_search/services/agent-schedules';
import { AgentProjectGrants } from '../../../../src/modules/enterprise_search/services/agent-project-grants';

describe('Agent schedule access boundaries', () => {
  afterEach(() => sinon.restore());
  const valid = {
    enabled: true,
    days: [1, 3, 5],
    hour: 9,
    minute: 0,
    timezone: 'Europe/Rome',
    prompt: 'Public brief',
  };
  it('rejects invalid timezones, duplicate days and client identity fields', () => {
    for (const body of [
      { ...valid, timezone: 'invalid' },
      { ...valid, days: [1, 1] },
      { ...valid, orgId: 'foreign' },
      { ...valid, hour: 24 },
    ]) {
      assert.equal(agentScheduleInput.safeParse(body).success, false);
    }
  });
  it('requires both write and execute scopes, then verifies ownership before any save', async () => {
    const container = new Container();
    let scopes: string[] = ['agent:read', 'agent:write'];
    container.bind('AuthMiddleware').toConstantValue({
      authenticate: (
        req: AuthenticatedUserRequest,
        _res: express.Response,
        next: express.NextFunction,
      ) => {
        req.user = {
          userId: 'owner',
          orgId: 'org',
          isOAuth: true,
          oauthScopes: scopes,
        };
        asAccount('org', 'owner', 'test:verified-auth', next);
      },
    });
    const owner = sinon
      .stub(ScheduledAgentRuntime.prototype, 'checkOwner')
      .rejects(new Error('creator only'));
    const save = sinon.stub(AgentSchedules.prototype, 'saveSchedule');
    container
      .bind(ScheduledAgentRuntime)
      .toConstantValue(Object.create(ScheduledAgentRuntime.prototype));
    const app = express();
    app.use(express.json());
    app.use('/agents/:agentKey/schedule', createAgentScheduleRouter(container));
    app.use(
      (
        err: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(403).json({ error: err.message });
      },
    );
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const path = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agents/e6ed44ce-65cc-42db-95bc-5db456f5f450/schedule`;
    const send = async (method: string, url = path) => {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'PUT' ? JSON.stringify(valid) : undefined,
      });
      assert.equal(response.status, 403);
    };
    try {
      await send('PUT');
      assert.equal(owner.callCount, 0);
      scopes = ['agent:read', 'agent:execute'];
      await send('PUT');
      assert.equal(owner.callCount, 0);
      scopes = ['agent:read', 'agent:write', 'agent:execute'];
      await send('PUT');
      assert.equal(owner.callCount, 1);
      assert.equal(save.callCount, 0);
      scopes = ['agent:read'];
      await send('POST', path + '/run');
      assert.equal(owner.callCount, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('validates paused destination edits but lets a former admin pause an unchanged destination', async () => {
    const container = new Container();
    container.bind('AuthMiddleware').toConstantValue({
      authenticate: (
        req: AuthenticatedUserRequest,
        _res: express.Response,
        next: express.NextFunction,
      ) => {
        req.user = {
          userId: 'owner',
          orgId: 'org',
          isOAuth: true,
          oauthScopes: ['agent:read', 'agent:write', 'agent:execute'],
        };
        asAccount('org', 'owner', 'test:verified-auth', next);
      },
    });
    const bot = '120d1a70-989a-499b-8e41-170b2a07a820';
    const runtime = Object.create(
      ScheduledAgentRuntime.prototype,
    ) as ScheduledAgentRuntime;
    sinon.stub(runtime, 'checkOwner').resolves({});
    const delivery = sinon
      .stub(runtime, 'checkDelivery')
      .rejects(new Error('not admin'));
    const schedules = Object.create(AgentSchedules.prototype) as AgentSchedules;
    sinon
      .stub(schedules, 'read')
      .resolves({ slackBotId: bot, slackChannelId: 'C0C6WPPH5V0' });
    const save = sinon.stub(schedules, 'saveSchedule').resolves({});
    container.bind(ScheduledAgentRuntime).toConstantValue(runtime);
    container.bind(AgentSchedules).toConstantValue(schedules);
    const app = express();
    app.use(express.json());
    app.use('/agents/:agentKey/schedule', createAgentScheduleRouter(container));
    app.use(
      (
        _err: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.sendStatus(403);
      },
    );
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const path = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agents/e6ed44ce-65cc-42db-95bc-5db456f5f450/schedule`;
    const send = (channel: string) =>
      fetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...valid,
          enabled: false,
          slackBotId: bot,
          slackChannelId: channel,
        }),
      });
    try {
      assert.equal((await send('C0C6WPPH5V0')).status, 200);
      assert.equal(delivery.callCount, 0);
      assert.equal(save.callCount, 1);
      assert.equal((await send('C0123456789')).status, 403);
      assert.equal(delivery.callCount, 1);
      assert.equal(save.callCount, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('requires project scope and an approved matching grant and refuses Slack destinations', async () => {
    let scopes = ['agent:read'];
    const container = new Container();
    container.bind('AuthMiddleware').toConstantValue({
      authenticate: (
        req: AuthenticatedUserRequest,
        _res: express.Response,
        next: express.NextFunction,
      ) => {
        req.user = {
          userId: 'owner',
          orgId: 'org',
          isOAuth: true,
          oauthScopes: scopes,
        };
        asAccount('org', 'owner', 'test:verified-auth', next);
      },
    });
    const runtime = Object.create(
      ScheduledAgentRuntime.prototype,
    ) as ScheduledAgentRuntime;
    sinon.stub(runtime, 'checkOwner').resolves({ createdBy: 'owner' });
    sinon.stub(runtime, 'checkDelivery').resolves(null);
    const grants = Object.create(
      AgentProjectGrants.prototype,
    ) as AgentProjectGrants;
    sinon.stub(grants, 'preview').resolves({
      project: { name: 'private object' },
      modelFingerprint: 'secret-metadata',
      projectId: 'project',
      fingerprint: 'a'.repeat(64),
    });
    const approve = sinon.stub(grants, 'approve').resolves({ id: 'grant-1' });
    const validate = sinon
      .stub(grants, 'validate')
      .resolves({ grant: { id: 'grant-1' } });
    const schedules = Object.create(AgentSchedules.prototype) as AgentSchedules;
    sinon.stub(schedules, 'read').resolves(null);
    const save = sinon.stub(schedules, 'saveSchedule').resolves({});
    container.bind(ScheduledAgentRuntime).toConstantValue(runtime);
    container.bind(AgentProjectGrants).toConstantValue(grants);
    container.bind(AgentSchedules).toConstantValue(schedules);
    const app = express();
    app.use(express.json());
    app.use('/agents/:agentKey/schedule', createAgentScheduleRouter(container));
    app.use(
      (
        _err: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.sendStatus(403);
      },
    );
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const path = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agents/e6ed44ce-65cc-42db-95bc-5db456f5f450/schedule`;
    const send = (method: string, suffix: string, body?: object) =>
      fetch(path + suffix, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      assert.equal(
        (await send('GET', '/project-grant/preview?projectId=project')).status,
        403,
      );
      scopes = ['agent:read', 'project:read'];
      const preview = await (
        await send('GET', '/project-grant/preview?projectId=project')
      ).json();
      assert.equal(preview.fingerprint, 'a'.repeat(64));
      assert.equal(preview.modelFingerprint, undefined);
      assert.equal(preview.project, undefined);
      assert.equal(
        (
          await send('POST', '/project-grant', {
            projectId: 'project',
            fingerprint: 'a'.repeat(64),
          })
        ).status,
        403,
      );
      scopes.push('agent:write', 'agent:execute');
      assert.equal(
        (
          await send('POST', '/project-grant', {
            projectId: 'project',
            fingerprint: 'a'.repeat(64),
          })
        ).status,
        201,
      );
      assert.equal(approve.callCount, 1);
      assert.equal(
        (
          await send('PUT', '', {
            ...valid,
            projectId: 'project',
            slackBotId: '120d1a70-989a-499b-8e41-170b2a07a820',
            slackChannelId: 'C0C6WPPH5V0',
          })
        ).status,
        403,
      );
      assert.equal(validate.callCount, 0);
      assert.equal(save.callCount, 0);
      assert.equal(
        (await send('PUT', '', { ...valid, projectId: 'project' })).status,
        200,
      );
      assert.equal(validate.callCount, 1);
      assert.equal(save.firstCall.args[3].projectGrantId, 'grant-1');
      scopes = ['agent:read', 'agent:write', 'agent:execute'];
      assert.equal(
        (await send('PUT', '', { ...valid, projectId: 'project' })).status,
        403,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
