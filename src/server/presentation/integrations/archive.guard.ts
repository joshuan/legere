import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthenticateApiToken } from '../../application/auth/authenticate-api-token';
import { ForbiddenError, DomainError } from '../../domain/errors/domain-error';
import { AppConfig } from '../../infrastructure/config/app-config';
import { attachCaller } from '../auth/current-user';
import { bearerTokenOf } from '../http/bearer';

@Injectable()
export class ArchiveGuard implements CanActivate {
  constructor(
    private readonly authenticate: AuthenticateApiToken,
    private readonly config: AppConfig,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    const baseUrl = this.config.get('APP_BASE_URL').replace(/\/+$/, '');
    try {
      const caller = await this.authenticate.execute(bearerTokenOf(request));
      if (
        caller.kind !== 'API_TOKEN' ||
        caller.apiToken.scope !== 'ARCHIVE' ||
        caller.apiToken.oauthGrantId == null ||
        caller.apiToken.oauthScope !== 'documents:read' ||
        caller.apiToken.oauthResource !== `${baseUrl}/api/integrations/archive`
      )
        throw new ForbiddenError('This endpoint requires personal archive OAuth access');
      attachCaller(request, caller);
      return true;
    } catch (error) {
      if (error instanceof DomainError && (error.httpStatus === 401 || error.httpStatus === 403))
        response.setHeader(
          'WWW-Authenticate',
          `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/api/integrations/archive", scope="documents:read", error="${error.httpStatus === 403 ? 'insufficient_scope' : 'invalid_token'}"`,
        );
      throw error;
    }
  }
}
