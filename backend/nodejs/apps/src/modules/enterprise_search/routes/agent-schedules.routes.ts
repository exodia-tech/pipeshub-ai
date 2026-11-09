import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Container } from 'inversify';
import { AuthMiddleware } from '../../../libs/middlewares/auth.middleware';
import { AuthenticatedUserRequest } from '../../../libs/middlewares/types';
import { requireScopes } from '../../../libs/middlewares/require-scopes.middleware';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import { ValidationMiddleware } from '../../../libs/middlewares/validation.middleware';
import { AgentSchedules } from '../services/agent-schedules';
import { ScheduledAgentRuntime, requirePublicResearchAgent } from '../services/scheduled-agent-runtime';
import { AgentProjectGrants } from '../services/agent-project-grants';
import { ForbiddenError } from '../../../libs/errors/http.errors';
import { Logger } from '../../../libs/services/logger.service';

const logger = Logger.getInstance({ service: 'AgentScheduleApproval' });

export const agentScheduleInput = z.object({
  enabled: z.boolean(),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(days => new Set(days).size === days.length),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  timezone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }),
  prompt: z.string().trim().min(1).max(8000),
  revision: z.number().int().min(0).optional(),
  slackBotId: z.string().uuid().nullable().optional(),
  slackChannelId: z.string().regex(/^[CG][A-Z0-9]{8,20}$/).nullable().optional(),
  projectId: z.string().trim().min(1).max(128).nullable().optional(),
}).strict();
const params = z.object({ agentKey: z.string().uuid() });

export function createAgentScheduleRouter(container: Container): Router {
  const router = Router({ mergeParams: true });
  const auth = container.get<AuthMiddleware>('AuthMiddleware');
  router.use(auth.authenticate, ValidationMiddleware.validate(z.object({ params })));

  const handle = (fn: (req: AuthenticatedUserRequest, res: Response) => Promise<void>) =>
    (req: AuthenticatedUserRequest, res: Response, next: NextFunction): void => {
      void fn(req, res).catch(next);
    };
  const check = (req: AuthenticatedUserRequest, publicOnly: boolean): Promise<unknown> =>
    container.get(ScheduledAgentRuntime).checkOwner(String(req.params.agentKey), req.user!.userId, {
      Authorization: String(req.headers.authorization),
    }, publicOnly);
  const projectScope = requireScopes(OAuthScopeNames.PROJECT_READ);

  router.get('/project-grant/preview', requireScopes(OAuthScopeNames.AGENT_READ), projectScope,
    ValidationMiddleware.validate(z.object({ query: z.object({ projectId: z.string().trim().min(1).max(128) }) })), handle(async (req, res) => {
      const agent = await check(req, false) as Record<string, unknown>;
      const { project: _project, modelFingerprint: _modelFingerprint, ...preview } = await container.get(AgentProjectGrants).preview(req.user!.orgId, req.user!.userId, agent, String(req.query.projectId));
      res.json(preview);
    }));
  router.post('/project-grant', requireScopes(OAuthScopeNames.AGENT_READ), requireScopes(OAuthScopeNames.AGENT_WRITE), requireScopes(OAuthScopeNames.AGENT_EXECUTE), projectScope,
    ValidationMiddleware.validate(z.object({ body: z.object({ projectId: z.string().trim().min(1).max(128), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).strict() })), handle(async (req, res) => {
      const agentId = String(req.params.agentKey);
      const agent = await check(req, false) as Record<string, unknown>;
      const grant = await container.get(AgentProjectGrants).approve(req.user!.orgId, req.user!.userId, agentId, agent, req.body.projectId, req.body.fingerprint);
      logger.info('Project schedule scope approved', { audit: 'agent_schedule_grant', action: 'approved', orgId: grant.orgId, userId: grant.userId, agentId, projectId: grant.projectId, grantId: grant.id });
      res.status(201).json({ grant });
    }));
  router.delete('/project-grant', requireScopes(OAuthScopeNames.AGENT_READ), requireScopes(OAuthScopeNames.AGENT_WRITE), projectScope, handle(async (req, res) => {
    await check(req, false);
    await container.get(AgentProjectGrants).revoke(req.user!.orgId, req.user!.userId, String(req.params.agentKey));
    logger.info('Project schedule scope revoked', { audit: 'agent_schedule_grant', action: 'revoked', orgId: req.user!.orgId, userId: req.user!.userId, agentId: String(req.params.agentKey) });
    res.status(204).end();
  }));

  router.get('/slack-bots', requireScopes(OAuthScopeNames.AGENT_READ), handle(async (req, res) => {
    await check(req, false);
    res.json(await container.get(ScheduledAgentRuntime).deliveryOptions(req.user!.orgId, req.user!.userId, String(req.params.agentKey)));
  }));

  router.get('/', requireScopes(OAuthScopeNames.AGENT_READ), handle(async (req, res) => {
    await check(req, false);
    res.json({ schedule: await container.get(AgentSchedules).read(req.user!.orgId, req.user!.userId, String(req.params.agentKey)) });
  }));
  router.put('/', requireScopes(OAuthScopeNames.AGENT_READ), requireScopes(OAuthScopeNames.AGENT_WRITE), requireScopes(OAuthScopeNames.AGENT_EXECUTE),
    ValidationMiddleware.validate(z.object({ body: agentScheduleInput })), handle(async (req, res) => {
      const agent = await check(req, false) as Record<string, unknown>;
      const previous = await container.get(AgentSchedules).read(req.user!.orgId, req.user!.userId, String(req.params.agentKey));
      const projectId = req.body.projectId === undefined ? previous?.projectId ?? null : req.body.projectId;
      const projectChanged = projectId !== (previous?.projectId ?? null);
      let projectGrantId = projectId ? previous?.projectGrantId ?? null : null;
      if (projectId && (req.body.slackBotId || req.body.slackChannelId)) throw new ForbiddenError('Project drafts cannot be delivered to Slack.');
      if (projectId && (req.body.enabled || projectChanged)) {
        if (req.user!.isOAuth && !req.user!.oauthScopes?.includes(OAuthScopeNames.PROJECT_READ)) throw new ForbiddenError('Project schedules require project:read.');
        const { grant } = await container.get(AgentProjectGrants).validate(req.user!.orgId, req.user!.userId, String(req.params.agentKey), agent, projectId);
        projectGrantId = grant.id;
      } else if (!projectId && req.body.enabled) requirePublicResearchAgent(agent);
      const deliveryChanged = (req.body.slackBotId ?? null) !== (previous?.slackBotId ?? null) || (req.body.slackChannelId ?? null) !== (previous?.slackChannelId ?? null);
      if (req.body.enabled || deliveryChanged) await container.get(ScheduledAgentRuntime).checkDelivery({ ...req.body, orgId: req.user!.orgId, userId: req.user!.userId, agentId: String(req.params.agentKey) });
      res.json({ schedule: await container.get(AgentSchedules).save(req.user!.orgId, req.user!.userId, String(req.params.agentKey), { ...req.body, projectId, projectGrantId }) });
    }));
  router.post('/run', requireScopes(OAuthScopeNames.AGENT_READ), requireScopes(OAuthScopeNames.AGENT_EXECUTE), handle(async (req, res) => {
    const agent = await check(req, false) as Record<string, unknown>;
    const schedule = await container.get(AgentSchedules).read(req.user!.orgId, req.user!.userId, String(req.params.agentKey));
    if (schedule?.projectId) {
      if (req.user!.isOAuth && !req.user!.oauthScopes?.includes(OAuthScopeNames.PROJECT_READ)) throw new ForbiddenError('Project schedules require project:read.');
      if (!schedule.projectGrantId || schedule.slackBotId || schedule.slackChannelId) throw new ForbiddenError('Project schedules need an approved scope and cannot post to Slack.');
      await container.get(AgentProjectGrants).validate(req.user!.orgId, req.user!.userId, String(req.params.agentKey), agent, schedule.projectId, schedule.projectGrantId ?? undefined);
    } else requirePublicResearchAgent(agent);
    await container.get(AgentSchedules).runNow(req.user!.orgId, req.user!.userId, String(req.params.agentKey));
    res.json({ schedule: await container.get(AgentSchedules).read(req.user!.orgId, req.user!.userId, String(req.params.agentKey)) });
  }));
  return router;
}
