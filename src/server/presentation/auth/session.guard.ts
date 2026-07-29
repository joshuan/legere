import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { SESSION_COOKIE_NAME } from '../http/session-cookie';
import { attachCaller } from './current-user';

// First guard in the chain (docs/06 §6.4): resolves the session cookie and attaches the caller.
// Throws UnauthenticatedError/ForbiddenError, which the global filter maps to 401/403.
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly authenticate: AuthenticateSession) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const cookies: Record<string, string> = req.cookies ?? {};
    const caller = await this.authenticate.execute(cookies[SESSION_COOKIE_NAME]);
    attachCaller(req, caller);
    return true;
  }
}
