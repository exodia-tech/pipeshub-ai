import jwt from 'jsonwebtoken';
import { AppConfig } from '../../modules/tokens_manager/config/config';
import { isUserOrgAdmin } from '../../modules/user_management/services/user-admin.service';
import { ServiceUnavailableError } from '../errors/http.errors';
import { TokenScopes } from '../enums/token-scopes.enum';
import { getAllowedScopeNamesForRole } from '../../modules/oauth_provider/config/scopes.config';

/** Live, request-bound policy lookup; a graph outage is never an unrestricted grant. */
export function groupScopeResolver(config: Pick<AppConfig, 'connectorBackend' | 'scopedJwtSecret'>, adminRecovery = true) {
  const names = new Set(getAllowedScopeNamesForRole(false).filter((scope) => scope.includes(':')));
  return async (orgId: string, userId: string): Promise<string[] | null> => {
    try {
      if (adminRecovery && await isUserOrgAdmin(userId, orgId)) return null;
      const token = jwt.sign({ orgId, userId, scopes: [TokenScopes.ACCESS_GROUP_MANAGE] }, config.scopedJwtSecret, { expiresIn: '1m' });
      const response = await fetch(`${config.connectorBackend}/api/v1/entity/access-groups/effective-scopes`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Scope lookup failed');
      const body: unknown = await response.json();
      const scopes = body && typeof body === 'object' ? (body as { scopes?: unknown }).scopes : undefined;
      if (scopes === null) return null;
      if (!Array.isArray(scopes) || scopes.length > 100 || scopes.some((scope) => typeof scope !== 'string' || !names.has(scope))) {
        throw new Error('Invalid scope lookup');
      }
      return scopes;
    } catch {
      throw new ServiceUnavailableError('Feature permissions could not be verified. Please retry.');
    }
  };
}
