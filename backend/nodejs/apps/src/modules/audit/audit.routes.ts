import { Container } from 'inversify';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AuthMiddleware } from '../../libs/middlewares/auth.middleware';
import { requireScopes } from '../../libs/middlewares/require-scopes.middleware';
import { OAuthScopeNames } from '../../libs/enums/oauth-scopes.enum';
import { userAdminCheck } from '../user_management/middlewares/userAdminCheck';
import {
  AuthenticatedServiceRequest,
  AuthenticatedUserRequest,
} from '../../libs/middlewares/types';
import { TokenScopes } from '../../libs/enums/token-scopes.enum';
import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  AuditAction,
  listAuditEvents,
  recordAuditEvent,
} from './audit.store';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const agentEvent = z
  .object({
    event_id: z.uuid(),
    action: z.enum(['agent.run', 'agent.tool']),
    outcome: z.enum(AUDIT_OUTCOMES),
    agent_event: z
      .object({
        run_id: identifier,
        trace_id: identifier,
        agent_id: identifier,
        parent_run_id: identifier.optional(),
        tool_call_id: identifier.optional(),
        tool_name: z
          .string()
          .regex(/^[a-zA-Z0-9_.:/-]{1,256}$/)
          .optional(),
        model: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[^\x00-\x1f]+$/)
          .optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (event) =>
      event.action !== 'agent.tool' ||
      Boolean(event.agent_event.tool_name && event.agent_event.tool_call_id),
  );

const serviceIdentity = z.object({
  orgId: z.string().regex(/^[a-fA-F0-9]{24}$/),
  userId: identifier,
  scopes: z
    .array(z.string())
    .refine((scopes) => scopes.includes(TokenScopes.AUDIT_WRITE)),
  exp: z.number(),
});

export function createAuditRouter(container: Container): Router {
  const router = Router();
  const auth = container.get<AuthMiddleware>('AuthMiddleware');
  router.post(
    '/internal/events',
    auth.scopedTokenValidator(TokenScopes.AUDIT_WRITE),
    async (req: AuthenticatedServiceRequest, res, next) => {
      try {
        const identity = serviceIdentity.safeParse(req.tokenPayload);
        if (!identity.success) {
          res
            .status(401)
            .json({
              error: 'An organization-scoped audit service token is required',
            });
          return;
        }
        const event = agentEvent.safeParse(req.body);
        if (!event.success) {
          res.status(400).json({ error: 'Invalid agent audit event' });
          return;
        }
        await recordAuditEvent({
          org_id: identity.data.orgId,
          actor_id: identity.data.userId,
          operation_id: event.data.event_id,
          action: event.data.action,
          outcome: event.data.outcome,
          agent_event: event.data.agent_event,
          group_ids: [],
          member_ids: [],
        });
        res.status(201).json({ recorded: true });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get(
    '/',
    auth.authenticate,
    requireScopes(OAuthScopeNames.CONFIG_READ),
    userAdminCheck,
    async (req: AuthenticatedUserRequest, res, next) => {
      try {
        if (req.query.export !== undefined && req.query.export !== 'true') {
          res.status(400).json({ error: 'Invalid export option' });
          return;
        }
        const action = req.query.action;
        if (
          action !== undefined &&
          (typeof action !== 'string' ||
            !AUDIT_ACTIONS.includes(action as AuditAction))
        ) {
          res.status(400).json({ error: 'Invalid audit action' });
          return;
        }
        const rawLimit = req.query.limit ?? '50';
        if (
          typeof rawLimit !== 'string' ||
          !/^[1-9][0-9]{0,2}$/.test(rawLimit) ||
          Number(rawLimit) > 100
        ) {
          res.status(400).json({ error: 'Invalid audit page size' });
          return;
        }
        let before: { time: Date; id: string } | undefined;
        if (req.query.cursor !== undefined) {
          try {
            const cursor = req.query.cursor;
            if (
              typeof cursor !== 'string' ||
              cursor.length > 256 ||
              !/^[A-Za-z0-9_-]+$/.test(cursor)
            )
              throw new Error();
            const decoded = JSON.parse(
              Buffer.from(cursor, 'base64url').toString('utf8'),
            ) as { time?: unknown; id?: unknown };
            if (
              typeof decoded.time !== 'string' ||
              typeof decoded.id !== 'string' ||
              !/^[a-f0-9]{24}$/.test(decoded.id)
            )
              throw new Error();
            const time = new Date(decoded.time);
            if (
              !Number.isFinite(time.getTime()) ||
              time.toISOString() !== decoded.time
            )
              throw new Error();
            before = { time, id: decoded.id };
          } catch {
            res.status(400).json({ error: 'Invalid audit cursor' });
            return;
          }
        }
        const {
          actor_id: actorId,
          group_id: groupId,
          resource_id: resourceId,
          outcome,
          from,
          to,
        } = req.query;
        if (
          (actorId !== undefined &&
            (typeof actorId !== 'string' ||
              !/^[a-fA-F0-9]{24}$/.test(actorId))) ||
          (groupId !== undefined &&
            (typeof groupId !== 'string' ||
              !/^(?:[a-fA-F0-9]{24}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12})$/.test(
                groupId,
              )))
        ) {
          res.status(400).json({ error: 'Invalid audit identifier' });
          return;
        }
        if (
          resourceId !== undefined &&
          (typeof resourceId !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,256}$/.test(resourceId))
        ) {
          res.status(400).json({ error: 'Invalid audit resource' });
          return;
        }
        if (
          outcome !== undefined &&
          (typeof outcome !== 'string' ||
            !(AUDIT_OUTCOMES as readonly string[]).includes(outcome))
        ) {
          res.status(400).json({ error: 'Invalid audit outcome' });
          return;
        }
        const parseTime = (value: unknown): Date | undefined => {
          if (value === undefined) return undefined;
          if (typeof value !== 'string' || !value.endsWith('Z'))
            throw new Error();
          const date = new Date(value);
          if (!Number.isFinite(date.getTime())) throw new Error();
          return date;
        };
        let start: Date | undefined, end: Date | undefined;
        try {
          start = parseTime(from);
          end = parseTime(to);
          if (start && end && start >= end) throw new Error();
        } catch {
          res.status(400).json({ error: 'Invalid UTC audit time range' });
          return;
        }
        const events = await listAuditEvents(String(req.user!.orgId), {
          action: action as AuditAction | undefined,
          limit: Number(rawLimit),
          before,
          actorId: actorId as string | undefined,
          groupId: groupId as string | undefined,
          resourceId: resourceId as string | undefined,
          outcome: outcome as (typeof AUDIT_OUTCOMES)[number] | undefined,
          from: start,
          to: end,
        });
        await recordAuditEvent({
          org_id: String(req.user!.orgId),
          actor_id: String(req.user!.userId),
          operation_id: randomUUID(),
          request_id: req.context?.requestId,
          action: req.query.export === 'true' ? 'audit.export' : 'audit.read',
          outcome: 'success',
          group_ids: [],
          member_ids: [],
        });
        res.json(events);
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}
