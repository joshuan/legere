import { createHash } from 'node:crypto';
import { applyDecorators, UseGuards, type ExecutionContext } from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard, type ThrottlerModuleOptions } from '@nestjs/throttler';
import type { Request } from 'express';
import { SlidingWindowThrottlerStorage } from '../../infrastructure/throttling/sliding-window-throttler-storage';
import { callerOf } from '../auth/current-user';

// The four named budgets of docs/08 §8.4, in one place because a route asks for one of them by name
// and every other one has to be skipped for it — a list kept in two places is a route that quietly
// acquires a budget nobody meant it to have.
export type ThrottleBudget = { ttl: number; limit: number };

export const THROTTLE_NAMES = ['auth', 'catalogue', 'password', 'search'] as const;
export type ThrottleName = (typeof THROTTLE_NAMES)[number];

export const THROTTLE_BUDGETS: Record<ThrottleName, ThrottleBudget> = {
  // /api/auth/*, /api/invites/*, /api/password-resets/* — the Argon2-flooding brake login leans on.
  auth: { ttl: 60_000, limit: 20 },
  // 🔒 The open catalogue creates (SEC-56): fast enough for a person correcting an archive, far too
  // slow to fill a shared namespace by script.
  catalogue: { ttl: 60_000, limit: 30 },
  // 🔒 POST /api/me/password (SEC-54). The route verifies an Argon2 hash before it can fail, behind
  // the same concurrency gate of two that login queues at; without a budget in front of it one
  // signed-in account fills that queue and nobody on the instance can sign in. A person changes
  // their password once, not fifty times a minute.
  password: { ttl: 60_000, limit: 5 },
  // 🔒 GET /api/search and POST /api/mcp (SEC-74). Every non-text search spends one outbound
  // embeddings call on the operator's provider and a turn at the pipeline's embeddings gate, so a
  // read that costs money off-instance is metered like a write.
  search: { ttl: 60_000, limit: 30 },
};

// 🔒 A budget is counted against the caller, not the address they arrived from (docs/08 §8.4). The
// attacker of SEC-54 and SEC-74 is an account, and an account changes addresses far more easily
// than an address changes accounts. Anonymous routes — login, register, the two link previews —
// have no caller and keep the per-IP behaviour they always had.
function trackCaller(_req: Record<string, unknown>, context: ExecutionContext): string {
  const req = context.switchToHttp().getRequest<Request>();
  const caller = callerOf(req);
  if (caller !== undefined) return `user:${caller.user.id}`;
  return `ip:${req.ip ?? 'unknown'}`;
}

// 🔒 A budget is one allowance over the routes it names, not one per route. The package's own key
// carries the controller and the handler, which would have made "20 per 60 s on /api/auth/*" mean
// twenty per endpoint — the reading SEC-57 relied on to poll `register/verify` twenty times a
// minute while spending nothing elsewhere. The name and the caller are the whole key; hashed, so a
// long-lived map holds no addresses (docs/08 §8.4).
function keyOf(_context: ExecutionContext, tracker: string, name: string): string {
  return createHash('sha256').update(`${name}-${tracker}`).digest('hex');
}

// The module configuration, built here rather than inline in AppModule so the e2e harness can ask
// for the same shape with its own allowances.
export function throttlerOptions(
  budgets: Partial<Record<ThrottleName, ThrottleBudget>> = {},
): ThrottlerModuleOptions {
  return {
    throttlers: THROTTLE_NAMES.map((name) => ({
      name,
      ...(budgets[name] ?? THROTTLE_BUDGETS[name]),
    })),
    storage: new SlidingWindowThrottlerStorage(),
    getTracker: trackCaller,
    generateKey: keyOf,
  };
}

// Puts one named budget in front of a route and takes the other three off it. The guard walks every
// configured throttler on every request it covers, so opting in without opting out would charge a
// catalogue write against the login budget as well.
export function Throttled(name: ThrottleName): ReturnType<typeof applyDecorators> {
  const skipped: Record<string, boolean> = {};
  for (const other of THROTTLE_NAMES) {
    if (other !== name) skipped[other] = true;
  }
  return applyDecorators(UseGuards(ThrottlerGuard), SkipThrottle(skipped));
}
