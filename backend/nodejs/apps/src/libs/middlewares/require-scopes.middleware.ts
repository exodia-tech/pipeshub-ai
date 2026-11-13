import { Response, NextFunction } from 'express';
import { ForbiddenError } from '../errors/http.errors';
import { AuthenticatedUserRequest } from './types';
import { OAuthScopeNames } from '../enums/oauth-scopes.enum';

/** Undefined preserves unrestricted sessions; an empty array is an explicit denial. */
export function effectiveScopes(user: Record<string, unknown>): string[] | undefined {
  const limit = user.featureScopes;
  if (limit != null && (!Array.isArray(limit) || limit.some((scope) => typeof scope !== 'string'))) {
    throw new ForbiddenError('Feature permissions could not be verified');
  }
  const token = user.isOAuth === true
    ? (Array.isArray(user.oauthScopes) ? user.oauthScopes.filter((scope): scope is string => typeof scope === 'string') : [])
    : undefined;
  if (Array.isArray(limit)) return token ? token.filter((scope) => limit.includes(scope)) : limit;
  return token;
}

/**
 * Middleware factory that enforces OAuth scope validation on a per-route basis.
 *
 * Must be placed AFTER authMiddleware.authenticate in the middleware chain.
 *
 * - Live group limits apply to browser sessions and OAuth/PATs.
 * - For OAuth tokens: checks if token has at least ONE of the required scopes (OR logic)
 * - Throws ForbiddenError if insufficient scopes
 *
 * @example
 * router.get(
 *   '/',
 *   authMiddleware.authenticate,
 *   requireScopes(OAuthScopeNames.USER_READ),
 *   handler,
 * );
 */
export function requireScopes(...requiredScopes: OAuthScopeNames[]) {
  return async (
    req: AuthenticatedUserRequest,
    _res: Response,
    next: NextFunction,
  ) => {
    try {
      const user = req.user;

      if (!user) {
        throw new ForbiddenError('Authentication required');
      }

      if (req.resolveFeatureScopes) await req.resolveFeatureScopes();
      const scopes = effectiveScopes(user);
      const hasScope = scopes === undefined || requiredScopes.some((scope) => scopes.includes(scope));

      if (!hasScope) {
        throw new ForbiddenError(
          `Insufficient scope. Required: ${requiredScopes.join(' or ')}`,
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
