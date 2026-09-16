import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { ApiTokenScope } from '../../../shared/contracts/enums';
import { AuthenticateApiToken } from '../../application/auth/authenticate-api-token';
import { ForbiddenError } from '../../domain/errors/domain-error';
import { bearerTokenOf } from '../http/bearer';
import { attachCaller } from './current-user';

// A machine endpoint receives no session fallback: its Bearer token must carry precisely the scope
// the controller asks for. Authentication also checks expiry, revocation and active ownership.
@Injectable()
export class ApiTokenScopeGuard implements CanActivate {
  constructor(private readonly authenticate: AuthenticateApiToken) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const caller = await this.authenticate.execute(bearerTokenOf(request));
    if (caller.kind !== 'API_TOKEN') throw new Error('API token authentication returned a session');
    const scope = requiredScope(request.path);
    if (caller.apiToken.scope !== scope) {
      throw new ForbiddenError('This API token does not have permission for this inbox');
    }
    attachCaller(request, caller);
    return true;
  }
}

function requiredScope(path: string): ApiTokenScope {
  const normalized = path.replace(/\/+$/, '').toLowerCase();
  if (normalized.endsWith('/incoming/documents')) return 'DOCUMENTS_INGEST';
  if (normalized.endsWith('/incoming/receipts')) return 'RECEIPTS_INGEST';
  throw new Error('ApiTokenScopeGuard was used on an unknown route');
}
