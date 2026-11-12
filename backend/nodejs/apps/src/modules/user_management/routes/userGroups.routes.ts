import { randomUUID } from 'node:crypto';
import { currentOrgContext } from '../../../libs/context/orgContext';
import { AuditAction, recordAuditEvent } from '../../audit/audit.store';
import { Logger } from '../../../libs/services/logger.service';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Container } from 'inversify';
import { ValidationMiddleware } from '../../../libs/middlewares/validation.middleware';
import { AuthMiddleware } from '../../../libs/middlewares/auth.middleware';
import { userAdminCheck } from '../middlewares/userAdminCheck';
import { UserGroupController } from '../controller/userGroups.controller';
import { AuthenticatedUserRequest } from '../../../libs/middlewares/types';
import { requireScopes } from '../../../libs/middlewares/require-scopes.middleware';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';

const mongoObjectIdString = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, 'Invalid MongoDB ObjectId');

const UserGroupIdUrlParams = z.object({
  groupId: mongoObjectIdString,
});

const UserGroupIdValidationSchema = z.object({
  body: z.object({}),
  query: z.object({}),
  params: UserGroupIdUrlParams,
  headers: z.object({}),
});

const GroupUsersValidationSchema = z.object({
  body: z.object({}),
  query: z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
    search: z.string().optional(),
  }),
  params: UserGroupIdUrlParams,
  headers: z.object({}),
});

const getAllGroupsValidationSchema = z.object({
  body: z.object({}),
  query: z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
    search: z.string().optional(),
    createdAfter: z.iso.date().optional(),
    createdBefore: z.iso.date().optional(),
  }),
  params: z.object({}),
  headers: z.object({}),
});

const groupValidationSchema = z.object({
  body: z.object({
    type: z.string().min(1, 'type is required'),
    name: z.string().min(1, 'name is required'),
  }),
  query: z.object({}),
  params: z.object({}),
  headers: z.object({}),
});

const updateGroupValidationSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'name is required'),
  }),
  query: z.object({}),
  params: UserGroupIdUrlParams,
  headers: z.object({}),
});

const addRemoveUsersToGroupsBody = z.object({
  userIds: z
    .array(mongoObjectIdString)
    .min(1, 'At least one userId is required'),
  groupIds: z
    .array(mongoObjectIdString)
    .min(1, 'At least one groupId is required'),
});

/** POST /user-groups/add-users */
const AddUsersToGroupsValidationSchema = z.object({
  body: addRemoveUsersToGroupsBody,
  query: z.object({}),
  params: z.object({}),
  headers: z.object({}),
});

/** POST /user-groups/remove-users */
const RemoveUsersFromGroupsValidationSchema = z.object({
  body: addRemoveUsersToGroupsBody,
  query: z.object({}),
  params: z.object({}),
  headers: z.object({}),
});

const UserIdUrlParams = z.object({
  userId: mongoObjectIdString,
});

/** GET /user-groups/users/:userId */
const UserIdValidationSchema = z.object({
  body: z.object({}),
  query: z.object({}),
  params: UserIdUrlParams,
  headers: z.object({}),
});

export const groupAdminCheck =
  (action: AuditAction) =>
  async (
    req: AuthenticatedUserRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    await userAdminCheck(req, res, async (error?: unknown) => {
      if (!error) {
        next();
        return;
      }
      if (req.user?.userId) {
        try {
          await recordAuditEvent({
            org_id: String(currentOrgContext().orgId),
            actor_id: String(req.user.userId),
            operation_id: randomUUID(),
            request_id: req.context?.requestId,
            action,
            outcome: 'denied',
            group_ids: [],
            member_ids: [],
          });
        } catch {
          Logger.getInstance().error(
            'Group audit denial could not be recorded',
          );
        }
      }
      next(error);
    });
  };

export function createUserGroupRouter(container: Container) {
  const router = Router();

  const authMiddleware = container.get<AuthMiddleware>('AuthMiddleware');

  router.post(
    '/',
    authMiddleware.authenticate,
    requireScopes(OAuthScopeNames.USERGROUP_WRITE),
    ValidationMiddleware.validate(groupValidationSchema),
    groupAdminCheck('group.create'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userGroupController = container.get<UserGroupController>(
          'UserGroupController',
        );
        await userGroupController.createUserGroup(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/',
    authMiddleware.authenticate,
    requireScopes(OAuthScopeNames.USERGROUP_READ),
    ValidationMiddleware.validate(getAllGroupsValidationSchema),
    userAdminCheck,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userGroupController = container.get<UserGroupController>(
          'UserGroupController',
        );
        await userGroupController.getAllUserGroups(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  // Must be registered before `/:groupId` or `/health` is matched as groupId "health".
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  });

  router.get(
    '/:groupId',
    authMiddleware.authenticate,
    requireScopes(OAuthScopeNames.USERGROUP_READ),
    ValidationMiddleware.validate(UserGroupIdValidationSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const userGroupController = container.get<UserGroupController>(
          'UserGroupController',
        );
        await userGroupController.getUserGroupById(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    '/:groupId',
    authMiddleware.authenticate,
    requireScopes(OAuthScopeNames.USERGROUP_WRITE),
    groupAdminCheck('group.rename'),
    ValidationMiddleware.validate(updateGroupValidationSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const userGroupController = container.get<UserGroupController>(
          'UserGroupController',
        );
        await userGroupController.updateGroup(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    '/:groupId',
    authMiddleware.authenticate,
    requireScopes(OAuthScopeNames.USERGROUP_WRITE),
    groupAdminCheck('group.delete'),
    ValidationMiddleware.validate(UserGroupIdValidationSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const userGroupController = container.get<UserGroupController>(
          'UserGroupController',
        );
        await userGroupController.deleteGroup(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/add-users',
    authMiddleware.authenticate,
    requireScopes(OAuthScopeNames.USERGROUP_WRITE),
    groupAdminCheck('group.members.add'),
    ValidationMiddleware.validate(AddUsersToGroupsValidationSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const userGroupController = container.get<UserGroupController>(
          'UserGroupController',
        );
        await userGroupController.addUsersToGroups(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/remove-users',
    authMiddleware.authenticate,
    requireScopes(OAuthScopeNames.USERGROUP_WRITE),
    groupAdminCheck('group.members.remove'),
    ValidationMiddleware.validate(RemoveUsersFromGroupsValidationSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const userGroupController = container.get<UserGroupController>(
          'UserGroupController',
        );
        await userGroupController.removeUsersFromGroups(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/:groupId/users',
    authMiddleware.authenticate,
    requireScopes(OAuthScopeNames.USERGROUP_READ),
    ValidationMiddleware.validate(GroupUsersValidationSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const userGroupController = container.get<UserGroupController>(
          'UserGroupController',
        );
        await userGroupController.getUsersInGroup(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/users/:userId',
    authMiddleware.authenticate,
    requireScopes(OAuthScopeNames.USERGROUP_READ),
    ValidationMiddleware.validate(UserIdValidationSchema),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const userGroupController = container.get<UserGroupController>(
          'UserGroupController',
        );
        await userGroupController.getGroupsForUser(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/stats/list',
    authMiddleware.authenticate,
    requireScopes(OAuthScopeNames.USERGROUP_READ),
    async (
      req: AuthenticatedUserRequest,
      res: Response,
      next: NextFunction,
    ) => {
      try {
        const userGroupController = container.get<UserGroupController>(
          'UserGroupController',
        );
        await userGroupController.getGroupStatistics(req, res);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
