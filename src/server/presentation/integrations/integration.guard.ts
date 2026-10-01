import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticateApiToken } from '../../application/auth/authenticate-api-token';
import { ForbiddenError } from '../../domain/errors/domain-error';
import { attachCaller } from '../auth/current-user';
import { bearerTokenOf } from '../http/bearer';

@Injectable()
export class IntegrationGuard implements CanActivate {
  constructor(private readonly authenticate: AuthenticateApiToken) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const caller = await this.authenticate.execute(bearerTokenOf(request));
    if (
      caller.kind !== 'API_TOKEN' ||
      caller.apiToken.scope !== 'INTEGRATION' ||
      caller.apiToken.integrationId == null
    ) {
      throw new ForbiddenError('This endpoint requires an integration credential');
    }
    attachCaller(request, caller);
    return true;
  }
}
