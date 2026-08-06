import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticateApiToken } from '../../application/auth/authenticate-api-token';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { ReadOnlyTokenError } from '../../domain/errors/domain-error';
import { bearerTokenOf } from '../http/bearer';
import { SESSION_COOKIE_NAME } from '../http/session-cookie';
import { attachCaller } from './current-user';

// Methods an API token may reach — the same set the middleware in front of this guard uses.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// First guard in the chain (docs/06 §6.4): resolves the credential and attaches the caller.
// Throws UnauthenticatedError/ForbiddenError, which the global filter maps to 401/403.
//
// Two credentials, one guard: the `sid` cookie a browser sends, or an `Authorization: Bearer` API
// token a script sends (docs/08 §8.2a).
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
      // 🔒 The second of the two layers docs/08 §8.2a describes. The middleware before routing has
      // already refused this, and is where the refusal belongs — but a rule enforced in exactly one
      // place stops being enforced the moment a route is mounted somewhere that place does not
      // cover. Refusing to resolve the credential at all is what makes the sentence in §8.2a true.
      if (!SAFE_METHODS.has(req.method)) throw new ReadOnlyTokenError();
      attachCaller(req, await this.authenticateApiToken.execute(bearer));
      return true;
    }

    const cookies: Record<string, string> = req.cookies ?? {};
    const caller = await this.authenticate.execute(cookies[SESSION_COOKIE_NAME]);
    attachCaller(req, caller);
    return true;
  }
}
