import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticateApiToken } from '../../application/auth/authenticate-api-token';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { bearerTokenOf } from '../http/bearer';
import { SESSION_COOKIE_NAME } from '../http/session-cookie';
import { attachCaller } from './current-user';

// First guard in the chain (docs/06 §6.4): resolves the credential and attaches the caller.
// Throws UnauthenticatedError/ForbiddenError, which the global filter maps to 401/403.
//
// Two credentials, one guard: the `sid` cookie a browser sends, or an `Authorization: Bearer` API
// token a script sends (docs/08 §8.2a). A bearer token never reaches a mutating route — the
// read-only middleware refused it before routing — so what arrives here is always a read.
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly authenticate: AuthenticateSession,
    private readonly authenticateApiToken: AuthenticateApiToken,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    const bearer = bearerTokenOf(req);
    if (bearer !== undefined) {
      attachCaller(req, await this.authenticateApiToken.execute(bearer));
      return true;
    }

    const cookies: Record<string, string> = req.cookies ?? {};
    const caller = await this.authenticate.execute(cookies[SESSION_COOKIE_NAME]);
    attachCaller(req, caller);
    return true;
  }
}
