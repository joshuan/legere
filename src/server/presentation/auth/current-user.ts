import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedCaller } from '../../application/auth/authenticate-session';
import { ForbiddenError } from '../../domain/errors/domain-error';
import type { Viewer } from '../../domain/repositories/document.repository';
import type { AgentIdentity } from '../../../shared/contracts/identity';

// SessionGuard attaches the resolved caller here so controllers and use cases never re-fetch it
// (docs/06 §6.4).
const CALLER_KEY = 'legereCaller';

type RequestWithCaller = Request & { [CALLER_KEY]?: AuthenticatedCaller };

export function attachCaller(req: Request, caller: AuthenticatedCaller): void {
  const target: RequestWithCaller = req;
  target[CALLER_KEY] = caller;
}

export function callerOf(req: Request): AuthenticatedCaller | undefined {
  const source: RequestWithCaller = req;
  return source[CALLER_KEY];
}

export function actorOf(caller: AuthenticatedCaller): Viewer {
  if (caller.kind === 'SESSION') return { id: caller.user.id, role: caller.user.role };
  const token = caller.apiToken;
  let agent: AgentIdentity = { kind: 'API_TOKEN', id: token.id, name: token.name };
  if (token.oauthGrantId != null) {
    agent = {
      kind: 'OAUTH',
      id: token.oauthGrantId,
      name: token.name,
      ...(token.oauthClientId == null ? {} : { clientId: token.oauthClientId }),
    };
  } else if (token.integrationId != null) {
    agent = {
      kind: 'INTEGRATION',
      id: token.integrationId,
      name: token.integrationName ?? token.name,
    };
  }
  return {
    id: caller.user.id,
    role: caller.user.role,
    agent,
    ...(token.integrationId == null ? {} : { integrationId: token.integrationId }),
  };
}

export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const caller = callerOf(context.switchToHttp().getRequest<Request>());
  if (caller === undefined) throw new Error('CurrentActor used without authentication');
  return actorOf(caller);
});

// @CurrentUser() — the authenticated user; only usable on routes behind SessionGuard.
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const caller = callerOf(context.switchToHttp().getRequest<Request>());
  if (caller === undefined) throw new Error('CurrentUser used on a route without SessionGuard');
  return caller.user;
});

// @CurrentSession() — the session backing this request (logout, the password change, the session
// list). A mutation carrying a bearer credential never gets this far, being refused before routing
// (docs/08 §8.2a); a *read* can, so the token case is a refusal rather than a crash: an API token
// has no session, and "which of these is you" is a question only a session can answer.
export const CurrentSession = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const caller = callerOf(context.switchToHttp().getRequest<Request>());
  if (caller === undefined) throw new Error('CurrentSession used on a route without SessionGuard');
  if (caller.kind !== 'SESSION') {
    throw new ForbiddenError('This endpoint needs a signed-in session, not an API token');
  }
  return caller.session;
});
