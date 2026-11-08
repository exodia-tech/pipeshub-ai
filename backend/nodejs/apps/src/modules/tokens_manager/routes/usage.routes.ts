import { Router } from 'express';
import { Container } from 'inversify';
import axios from 'axios';
import { AuthMiddleware } from '../../../libs/middlewares/auth.middleware';
import { requireScopes } from '../../../libs/middlewares/require-scopes.middleware';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import { AppConfig } from '../config/config';
import { buildProxyHeaders } from '../controllers/connector.controllers';
import { AuthenticatedUserRequest } from '../../../libs/middlewares/types';

export function createUsageRouter(container: Container): Router {
  const router = Router();
  const auth = container.get<AuthMiddleware>('AuthMiddleware');
  const config = container.get<AppConfig>('AppConfig');
  router.use(auth.authenticate.bind(auth));
  const forward = async (
    req: AuthenticatedUserRequest,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => {
    try {
      const response = await axios.request({
        url: `${config.aiBackend}/api/v1/usage${req.path === '/' ? '' : req.path}`,
        method: req.method,
        params: req.query,
        data: req.body,
        headers: buildProxyHeaders(req),
        timeout: 30_000,
        maxRedirects: 0,
        validateStatus: () => true,
      });
      res.status(response.status).json(response.data);
    } catch (error) {
      next(error);
    }
  };
  router.get('/', requireScopes(OAuthScopeNames.ORG_READ), forward);
  router.get('/budgets', requireScopes(OAuthScopeNames.ORG_READ), forward);
  router.get('/observability', requireScopes(OAuthScopeNames.CONFIG_READ), forward);
  router.put('/observability', requireScopes(OAuthScopeNames.CONFIG_WRITE), forward);
  router.get('/rates', requireScopes(OAuthScopeNames.CONFIG_READ), forward);
  router.put('/rates', requireScopes(OAuthScopeNames.CONFIG_WRITE), forward);
  router.delete('/rates', requireScopes(OAuthScopeNames.CONFIG_WRITE), forward);
  router.put('/budgets', requireScopes(OAuthScopeNames.CONFIG_WRITE), forward);
  router.delete(
    '/budgets/:budgetId',
    requireScopes(OAuthScopeNames.CONFIG_WRITE),
    forward,
  );
  return router;
}
