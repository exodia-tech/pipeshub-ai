import { currentOrgContext } from '../../../libs/context/orgContext';
import { randomUUID } from 'node:crypto';
import { Container } from 'inversify';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuthMiddleware } from '../../../libs/middlewares/auth.middleware';
import { AuthenticatedUserRequest } from '../../../libs/middlewares/types';
import { requireScopes } from '../../../libs/middlewares/require-scopes.middleware';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import { TokenScopes } from '../../../libs/enums/token-scopes.enum';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../../libs/errors/http.errors';
import { type AuditAction, recordAuditEvent } from '../../audit/audit.store';
import { AppConfig } from '../../tokens_manager/config/config';
import { groupAdminCheck } from './userGroups.routes';
import { userAdminCheck } from '../middlewares/userAdminCheck';

// eslint-disable-next-line no-control-regex -- Resource references must reject C0 control characters.
const resourceReference = /^(apps|recordGroups|records)\/[^/\x00-\x1f]{1,256}$/;
const accessPolicy = z.object({
  defaultAllow: z.boolean(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullish(),
  rules: z
    .array(
      z.object({
        ref: z.string().regex(resourceReference),
        allow: z.boolean(),
      }),
    )
    .max(1000),
});
const namedGroup = z.object({ name: z.string(), description: z.string().max(2000).optional() });
const groupMembers = z.object({
  userIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/i))
    .min(1)
    .max(500),
});

export function createAccessGroupsRouter(container: Container): Router {
  const router = Router();
  const auth = container.get<AuthMiddleware>('AuthMiddleware');
  const config = container.get<AppConfig>('AppConfig');
  for (const part of ['access', 'resources'] as const) {
    router.get(
      `/:id/${part}`,
      auth.authenticate.bind(auth),
      requireScopes(OAuthScopeNames.USERGROUP_READ),
      userAdminCheck,
      async (req: AuthenticatedUserRequest, res, next) => {
        try {
          const id = String(req.params.id);
          if (
            !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
              id,
            )
          )
            throw new BadRequestError('Invalid group');
          const query = new URLSearchParams();
          for (const key of ['parent', 'skip', 'limit']) {
            const value = req.query[key];
            if (value !== undefined) {
              if (typeof value !== 'string' || value.length > 300)
                throw new BadRequestError('Invalid resource page');
              query.set(key, value);
            }
          }
          const token = jwt.sign(
            {
              userId: String(currentOrgContext().userId),
              orgId: String(currentOrgContext().orgId),
              scopes: [TokenScopes.ACCESS_GROUP_MANAGE],
            },
            config.scopedJwtSecret,
            { expiresIn: '5m' },
          );
          const response = await fetch(
            `${config.connectorBackend}/api/v1/entity/access-groups/${id}/${part}?${query}`,
            {
              headers: { authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(15_000),
            },
          );
          if (response.status === 404)
            throw new NotFoundError('Group or resource not found');
          if (!response.ok)
            throw new ServiceUnavailableError(
              'Resource access service is unavailable.',
            );
          res.json(await response.json());
        } catch (error) {
          next(error);
        }
      },
    );
  }
  router.put(
    '/:id/access',
    auth.authenticate.bind(auth),
    requireScopes(OAuthScopeNames.USERGROUP_WRITE),
    groupAdminCheck('group.access.change'),
    async (req: AuthenticatedUserRequest, res, next) => {
      try {
        const id = String(req.params.id);
        const parsed = accessPolicy.safeParse(req.body);
        if (
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            id,
          ) ||
          !parsed.success
        )
          throw new BadRequestError('Invalid resource policy');
        const body = parsed.data;
        const audit = {
          org_id: String(currentOrgContext().orgId),
          actor_id: String(currentOrgContext().userId),
          operation_id: randomUUID(),
          request_id: req.context?.requestId,
          action: 'group.access.change' as const,
          group_ids: [id],
          member_ids: [],
          resource_policy: {
            default_allow: body.defaultAllow,
            revision: body.revision ?? 0,
            rules: body.rules.map((rule: { ref: string; allow: boolean }) => ({
              resource_ref: rule.ref,
              allow: rule.allow,
            })),
          },
        };
        await recordAuditEvent({ ...audit, outcome: 'intent' });
        const token = jwt.sign(
          {
            userId: audit.actor_id,
            orgId: audit.org_id,
            scopes: [TokenScopes.ACCESS_GROUP_MANAGE],
          },
          config.scopedJwtSecret,
          { expiresIn: '5m' },
        );
        const response = await fetch(
          `${config.connectorBackend}/api/v1/entity/access-groups/${id}/access`,
          {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              defaultAllow: body.defaultAllow,
              revision: body.revision ?? 0,
              rules: body.rules.map(
                (rule: { ref: string; allow: boolean }) => ({
                  ref: rule.ref,
                  allow: rule.allow,
                }),
              ),
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (response.status === 409)
          throw new ConflictError(
            'Another administrator changed this policy. Reload it before saving.',
          );
        if (response.status === 404)
          throw new NotFoundError('Group or resource not found');
        if (!response.ok)
          throw new ServiceUnavailableError(
            'The policy change could not be confirmed. Refresh before retrying.',
          );
        await recordAuditEvent({ ...audit, outcome: 'success' });
        res.json({ success: true });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get(
    '/',
    auth.authenticate.bind(auth),
    requireScopes(OAuthScopeNames.USERGROUP_READ),
    userAdminCheck,
    async (req: AuthenticatedUserRequest, res, next) => {
      try {
        const skip = req.query.skip ?? '0',
          limit = req.query.limit ?? '50';
        if (
          typeof skip !== 'string' ||
          !/^\d{1,7}$/.test(skip) ||
          typeof limit !== 'string' ||
          !/^[1-9]\d{0,2}$/.test(limit) ||
          Number(limit) > 100
        )
          throw new BadRequestError('Invalid group page');
        const token = jwt.sign(
          {
            userId: String(currentOrgContext().userId),
            orgId: String(currentOrgContext().orgId),
            scopes: [TokenScopes.ACCESS_GROUP_MANAGE],
          },
          config.scopedJwtSecret,
          { expiresIn: '5m' },
        );
        const response = await fetch(
          `${config.connectorBackend}/api/v1/entity/access-groups?skip=${skip}&limit=${limit}`,
          {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!response.ok)
          throw new ServiceUnavailableError('Group service is unavailable.');
        res.json(await response.json());
      } catch (error) {
        next(error);
      }
    },
  );
  router.get(
    '/:id/members',
    auth.authenticate.bind(auth),
    requireScopes(OAuthScopeNames.USERGROUP_READ),
    userAdminCheck,
    async (req: AuthenticatedUserRequest, res, next) => {
      try {
        const { id } = req.params,
          page = req.query.page ?? '1',
          limit = req.query.limit ?? '50';
        if (
          typeof id !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            id,
          ) ||
          typeof page !== 'string' ||
          !/^[1-9]\d{0,6}$/.test(page) ||
          typeof limit !== 'string' ||
          !/^[1-9]\d{0,2}$/.test(limit) ||
          Number(limit) > 100
        )
          throw new BadRequestError('Invalid group or member page');
        const token = jwt.sign(
          {
            userId: String(currentOrgContext().userId),
            orgId: String(currentOrgContext().orgId),
            scopes: [TokenScopes.ACCESS_GROUP_MANAGE],
          },
          config.scopedJwtSecret,
          { expiresIn: '5m' },
        );
        const response = await fetch(
          `${config.connectorBackend}/api/v1/entity/access-groups/${id}/members?page=${page}&limit=${limit}`,
          {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (response.status === 404) throw new NotFoundError('Group not found');
        if (!response.ok)
          throw new ServiceUnavailableError('Group service is unavailable.');
        res.json(await response.json());
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/',
    auth.authenticate.bind(auth),
    requireScopes(OAuthScopeNames.USERGROUP_WRITE),
    groupAdminCheck('group.create'),
    async (req: AuthenticatedUserRequest, res, next) => {
      try {
        const parsedName = namedGroup.safeParse(req.body);
        const name = parsedName.success ? parsedName.data.name : undefined;
        if (
          typeof name !== 'string' ||
          !name.trim() ||
          name.trim().length > 120
        )
          throw new BadRequestError('Invalid group name');
        const org_id = String(currentOrgContext().orgId);
        const actor_id = String(currentOrgContext().userId);
        const audit = {
          org_id,
          actor_id,
          operation_id: randomUUID(),
          request_id: req.context?.requestId,
          action: 'group.create' as const,
          group_ids: [] as string[],
          member_ids: [] as string[],
        };
        await recordAuditEvent({ ...audit, outcome: 'intent' });
        const token = jwt.sign(
          {
            userId: actor_id,
            orgId: org_id,
            scopes: [TokenScopes.ACCESS_GROUP_MANAGE],
          },
          config.scopedJwtSecret,
          { expiresIn: '5m' },
        );
        let response: globalThis.Response;
        try {
          response = await fetch(
            `${config.connectorBackend}/api/v1/entity/access-groups`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ name: name.trim(), description: parsedName.success ? parsedName.data.description?.trim() : undefined }),
              signal: AbortSignal.timeout(15_000),
            },
          );
        } catch {
          throw new ServiceUnavailableError(
            'The group may have been created. Check the group list before retrying.',
          );
        }
        if (response.status === 400)
          throw new BadRequestError(
            'The group name is invalid or already in use.',
          );
        if (!response.ok)
          throw new ServiceUnavailableError(
            'The group may have been created. Check the group list before retrying.',
          );
        let data: { id?: unknown };
        try {
          data = (await response.json()) as { id?: unknown };
        } catch {
          throw new ServiceUnavailableError(
            'The group may have been created. Check the group list before retrying.',
          );
        }
        if (
          typeof data.id !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            data.id,
          )
        )
          throw new ServiceUnavailableError(
            'The group may have been created. Check the group list before retrying.',
          );
        await recordAuditEvent({
          ...audit,
          group_ids: [data.id],
          outcome: 'success',
        });
        res.status(201).json({ id: data.id });
      } catch (error) {
        next(error);
      }
    },
  );
  for (const operation of ['add', 'remove'] as const) {
    const action: AuditAction =
      operation === 'add' ? 'group.members.add' : 'group.members.remove';
    router.post(
      `/:id/members/${operation}`,
      auth.authenticate.bind(auth),
      requireScopes(OAuthScopeNames.USERGROUP_WRITE),
      groupAdminCheck(action),
      async (req: AuthenticatedUserRequest, res, next) => {
        try {
          const { id } = req.params;
          const parsedMembers = groupMembers.safeParse(req.body);
          if (
            typeof id !== 'string' ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
              id,
            ) ||
            !parsedMembers.success
          )
            throw new BadRequestError('Invalid group or member IDs');
          const { userIds } = parsedMembers.data;
          const org_id = String(currentOrgContext().orgId),
            actor_id = String(currentOrgContext().userId);
          const audit = {
            org_id,
            actor_id,
            operation_id: randomUUID(),
            request_id: req.context?.requestId,
            action,
            group_ids: [id],
            member_ids: userIds,
          };
          await recordAuditEvent({ ...audit, outcome: 'intent' });
          const token = jwt.sign(
            {
              userId: actor_id,
              orgId: org_id,
              scopes: [TokenScopes.ACCESS_GROUP_MANAGE],
            },
            config.scopedJwtSecret,
            { expiresIn: '5m' },
          );
          let response: globalThis.Response;
          try {
            response = await fetch(
              `${config.connectorBackend}/api/v1/entity/access-groups/${id}/members?remove=${operation === 'remove'}`,
              {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${token}`,
                  'content-type': 'application/json',
                },
                body: JSON.stringify({ userIds }),
                signal: AbortSignal.timeout(15_000),
              },
            );
          } catch {
            throw new ServiceUnavailableError(
              'The membership may have changed. Check the group before retrying.',
            );
          }
          if (response.status === 404)
            throw new NotFoundError('Group or members not found');
          if (!response.ok)
            throw new ServiceUnavailableError(
              'The membership may have changed. Check the group before retrying.',
            );
          await recordAuditEvent({ ...audit, outcome: 'success' });
          res.json({ success: true });
        } catch (error) {
          next(error);
        }
      },
    );
  }
  for (const operation of ['rename', 'delete'] as const) {
    const action: AuditAction =
      operation === 'rename' ? 'group.rename' : 'group.delete';
    const handler = async (
      req: AuthenticatedUserRequest,
      res: import('express').Response,
      next: import('express').NextFunction,
    ): Promise<void> => {
      try {
        const { id } = req.params;
        const parsedName = namedGroup.safeParse(req.body);
        const name = parsedName.success ? parsedName.data.name : undefined;
        if (
          typeof id !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            id,
          ) ||
          (operation === 'rename' &&
            (typeof name !== 'string' ||
              !name.trim() ||
              name.trim().length > 120))
        )
          throw new BadRequestError('Invalid group or name');
        const org_id = String(currentOrgContext().orgId),
          actor_id = String(currentOrgContext().userId);
        const audit = {
          org_id,
          actor_id,
          operation_id: randomUUID(),
          request_id: req.context?.requestId,
          action,
          group_ids: [id],
          member_ids: [] as string[],
        };
        await recordAuditEvent({ ...audit, outcome: 'intent' });
        const token = jwt.sign(
          {
            userId: actor_id,
            orgId: org_id,
            scopes: [TokenScopes.ACCESS_GROUP_MANAGE],
          },
          config.scopedJwtSecret,
          { expiresIn: '5m' },
        );
        let response: globalThis.Response;
        try {
          response = await fetch(
            `${config.connectorBackend}/api/v1/entity/access-groups/${id}`,
            {
              method: operation === 'rename' ? 'PUT' : 'DELETE',
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
              },
              ...(operation === 'rename'
                ? { body: JSON.stringify({ name: name?.trim(), description: parsedName.success ? parsedName.data.description?.trim() : undefined }) }
                : {}),
              signal: AbortSignal.timeout(15_000),
            },
          );
        } catch {
          throw new ServiceUnavailableError(
            'The group may have changed. Check its current state before retrying.',
          );
        }
        if (response.status === 404) throw new NotFoundError('Group not found');
        if (!response.ok)
          throw new ServiceUnavailableError(
            'The group may have changed. Check its current state before retrying.',
          );
        await recordAuditEvent({ ...audit, outcome: 'success' });
        res.json({ success: true });
      } catch (error) {
        next(error);
      }
    };
    if (operation === 'rename')
      router.put(
        '/:id',
        auth.authenticate.bind(auth),
        requireScopes(OAuthScopeNames.USERGROUP_WRITE),
        groupAdminCheck(action),
        handler,
      );
    else
      router.delete(
        '/:id',
        auth.authenticate.bind(auth),
        requireScopes(OAuthScopeNames.USERGROUP_WRITE),
        groupAdminCheck(action),
        handler,
      );
  }
  return router;
}
