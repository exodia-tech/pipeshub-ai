import { Router, Response, NextFunction } from 'express';
import { currentOrgContext } from '../../../libs/context/orgContext';
import { Container } from 'inversify';
import multer from 'multer';
import { z } from 'zod';
import { AuthMiddleware } from '../../../libs/middlewares/auth.middleware';
import { AuthenticatedUserRequest } from '../../../libs/middlewares/types';
import { ValidationMiddleware } from '../../../libs/middlewares/validation.middleware';
import { requireScopes } from '../../../libs/middlewares/require-scopes.middleware';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import { BadRequestError } from '../../../libs/errors/http.errors';
import { createMulter } from '../../../libs/utils/multer.utils';
import {
  AgentPictures,
  AGENT_PICTURE_MAX_BYTES,
} from '../services/agent-pictures';
import { ScheduledAgentRuntime } from '../services/scheduled-agent-runtime';

export function createAgentPictureRouter(container: Container): Router {
  const router = Router({ mergeParams: true });
  const auth = container.get<AuthMiddleware>('AuthMiddleware');
  const headers = (req: AuthenticatedUserRequest) => ({
    Authorization: String(req.headers.authorization),
  });
  const handle =
    (fn: (req: AuthenticatedUserRequest, res: Response) => Promise<void>) =>
    (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
      void fn(req, res).catch(next);
    };
  const upload = createMulter({
    storage: multer.memoryStorage(),
    limits: { fileSize: AGENT_PICTURE_MAX_BYTES, files: 1, fields: 0 },
  });
  const receivePicture = (
    req: AuthenticatedUserRequest,
    res: Response,
    next: NextFunction,
  ) => {
    upload.single('file')(req, res, (error) =>
      next(
        error instanceof multer.MulterError
          ? new BadRequestError(
              'Choose one PNG, JPEG or WebP image smaller than 5 MB.',
            )
          : error,
      ),
    );
  };
  router.use(
    auth.authenticate,
    requireScopes(OAuthScopeNames.AGENT_READ),
    ValidationMiddleware.validate(
      z.object({ params: z.object({ agentKey: z.string().uuid() }) }),
    ),
  );
  router.put(
    '/',
    requireScopes(OAuthScopeNames.AGENT_WRITE),
    receivePicture,
    handle(async (req, res) => {
      const id = String(req.params.agentKey);
      const agent = await container
        .get(ScheduledAgentRuntime)
        .checkOwner(id, req.user!.userId, headers(req), false);
      if (!req.file) throw new BadRequestError('Choose a picture to upload.');
      const avatarUrl = await container
        .get(AgentPictures)
        .upload(
          currentOrgContext().orgId!,
          id,
          req.file.buffer,
          agent.avatarUrl,
          headers(req),
        );
      res.status(201).json({ avatarUrl });
    }),
  );
  router.get(
    '/:version',
    ValidationMiddleware.validate(
      z.object({
        params: z.object({
          agentKey: z.string().uuid(),
          version: z.string().uuid(),
        }),
      }),
    ),
    handle(async (req, res) => {
      const id = String(req.params.agentKey);
      const agent = await container
        .get(ScheduledAgentRuntime)
        .getAgent(id, headers(req));
      const dataUrl = await container
        .get(AgentPictures)
        .read(
          currentOrgContext().orgId!,
          id,
          String(req.params.version),
          agent.avatarUrl,
        );
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ dataUrl });
    }),
  );
  router.delete(
    '/',
    requireScopes(OAuthScopeNames.AGENT_WRITE),
    handle(async (req, res) => {
      const id = String(req.params.agentKey);
      const agent = await container
        .get(ScheduledAgentRuntime)
        .checkOwner(id, req.user!.userId, headers(req), false);
      await container
        .get(AgentPictures)
        .remove(currentOrgContext().orgId!, id, agent.avatarUrl, headers(req));
      res.json({ avatarUrl: null });
    }),
  );
  return router;
}
