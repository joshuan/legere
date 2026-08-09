import type { UserRole } from '../../../shared/contracts/enums';

// 🔒 The account journal (docs/06 §6.7, SEC-34). Documents have had a history since docs/03 §3.3.18;
// accounts had none, so after an incident nothing in the instance could say who signed in, from
// where, or when somebody's authority changed.
//
// This is a port and not a logger because the facts live in the framework-free application layer
// (docs/06 §6.1): *what* a record says belongs here, next to the use cases that know it, and *where*
// it goes belongs to infrastructure.

export type SecurityEventName =
  // The login flow. A refusal is one record, not two: either the attempt was wrong
  // (`login.failed`) or the backoff of docs/08 §8.4.1a refused to look at it (`login.throttled`).
  | 'login.succeeded'
  | 'login.failed'
  | 'login.throttled'
  // How an account comes to exist (docs/08 §8.1): the first admin, or an invite spent.
  | 'account.created'
  | 'invite.issued'
  | 'invite.accepted'
  | 'invite.revoked'
  // How a password changes (docs/08 §8.1.6, §8.1.6a).
  | 'password_reset.issued'
  | 'password_reset.completed'
  | 'password.changed'
  // Authority, and the credentials that carry it.
  | 'role.changed'
  | 'account.deactivated'
  | 'account.reactivated'
  | 'session.revoked'
  | 'api_token.created'
  | 'api_token.revoked';

// Who did it. `userId` is null exactly when the caller had not proved who they were — on the login
// flow, every record but the two a correct password reaches. The address is carried only where
// "from where" is the question the record exists to answer; everywhere else the request line logged
// under the same `requestId` already holds it (docs/06 §6.7).
export type SecurityActor = {
  userId: string | null;
  ip?: string;
};

// What it was done to. At most one account and at most one row:
//
// - `userId` — the account the event is about, when the server knows which one it is;
// - `email` — the address a caller *claimed*, on the login flow, where identity is a claim rather
//   than a fact, and the address an invite was addressed to;
// - `id` — the invite, reset, session or API token the event is about.
export type SecurityTarget = {
  userId?: string;
  email?: string;
  id?: string;
};

// Why a login was refused, in the vocabulary of docs/07 §7.2 — never the credential that was tried.
export type SecurityEventReason = 'CAPTCHA_FAILED' | 'INVALID_CREDENTIALS' | 'ACCOUNT_DEACTIVATED';

// The few facts the name alone does not carry. Deliberately a closed shape of enums and counts: a
// free-form bag is how a token, a code or a password eventually reaches a log line, and this type
// is what makes "the records carry no credential" a property of the compiler rather than of review.
export type SecurityEventDetail = {
  reason?: SecurityEventReason;
  // The role an invite grants, an account was created with, or an account moved to.
  role?: UserRole;
  // The role it moved from, so a demotion reads as one.
  fromRole?: UserRole;
  // How many sessions an action ended.
  sessions?: number;
};

export type SecurityEvent = {
  event: SecurityEventName;
  actor: SecurityActor;
  target: SecurityTarget;
  detail?: SecurityEventDetail;
};

export abstract class SecurityEvents {
  // Recording is not part of the work. A use case must not fail, and must not wait, because a
  // record could not be written — so this returns nothing, and the implementation throws nothing.
  // The request id and the time are the implementation's to add: the application knows what
  // happened, not which request it happened under.
  abstract record(event: SecurityEvent): void;
}
