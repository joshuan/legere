import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthenticateApiToken } from '../../application/auth/authenticate-api-token';
import { ForbiddenError, DomainError } from '../../domain/errors/domain-error';
import { AppConfig } from '../../infrastructure/config/app-config';
import { attachCaller } from '../auth/current-user';
import { bearerTokenOf } from '../http/bearer';

@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(
    private readonly authenticate: AuthenticateApiToken,
    private readonly config: AppConfig,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    try {
      const caller = await this.authenticate.execute(bearerTokenOf(request));
      if (
        caller.kind !== 'API_TOKEN' ||
        (caller.apiToken.scope !== 'READ' &&
          !(
            caller.apiToken.scope === 'MCP' &&
            caller.apiToken.oauthGrantId != null &&
            caller.apiToken.oauthResource ===
              `${this.config.get('APP_BASE_URL').replace(/\/+$/, '')}/api/mcp`
          ))
      ) {
        throw new ForbiddenError('This credential does not grant MCP read access');
      }
      attachCaller(request, caller);
      return true;
    } catch (error) {
      if (error instanceof DomainError && (error.httpStatus === 401 || error.httpStatus === 403)) {
        const baseUrl = this.config.get('APP_BASE_URL').replace(/\/+$/, '');
        const detail = error.httpStatus === 403 ? 'insufficient_scope' : 'invalid_token';
        context
          .switchToHttp()
          .getResponse<Response>()
          .setHeader(
            'WWW-Authenticate',
            `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/api/mcp", scope="mcp:read", error="${detail}"`,
          );
      }
      throw error;
    }
  }
}
