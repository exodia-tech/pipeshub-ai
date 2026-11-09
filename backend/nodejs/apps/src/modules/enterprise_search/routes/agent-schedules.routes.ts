import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Container } from 'inversify';
import { AuthMiddleware } from '../../../libs/middlewares/auth.middleware';
import { AuthenticatedUserRequest } from '../../../libs/middlewares/types';
import { requireScopes } from '../../../libs/middlewares/require-scopes.middleware';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import { ValidationMiddleware } from '../../../libs/middlewares/validation.middleware';
import { AgentSchedules } from '../services/agent-schedules';
import { ScheduledAgentRuntime } from '../services/scheduled-agent-runtime';

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
      await check(req, req.body.enabled);
      const previous = await container.get(AgentSchedules).read(req.user!.orgId, req.user!.userId, String(req.params.agentKey));
      const deliveryChanged = (req.body.slackBotId ?? null) !== (previous?.slackBotId ?? null) || (req.body.slackChannelId ?? null) !== (previous?.slackChannelId ?? null);
      if (req.body.enabled || deliveryChanged) await container.get(ScheduledAgentRuntime).checkDelivery({ ...req.body, orgId: req.user!.orgId, userId: req.user!.userId, agentId: String(req.params.agentKey) });
      res.json({ schedule: await container.get(AgentSchedules).save(req.user!.orgId, req.user!.userId, String(req.params.agentKey), req.body) });
    }));
  router.post('/run', requireScopes(OAuthScopeNames.AGENT_READ), requireScopes(OAuthScopeNames.AGENT_EXECUTE), handle(async (req, res) => {
    await check(req, true);
    await container.get(AgentSchedules).runNow(req.user!.orgId, req.user!.userId, String(req.params.agentKey));
    res.json({ schedule: await container.get(AgentSchedules).read(req.user!.orgId, req.user!.userId, String(req.params.agentKey)) });
  }));
  return router;
}
