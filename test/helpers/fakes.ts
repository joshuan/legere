import type { EmailVerification } from '../../src/server/domain/entities/email-verification';
import type { User } from '../../src/server/domain/entities/user';
import {
  EmailVerificationRepository,
  type CreateEmailVerificationInput,
  type IssueTicketInput,
} from '../../src/server/domain/repositories/email-verification.repository';
import {
  PasswordResetRepository,
  type CreatePasswordResetInput,
  type PasswordReset,
} from '../../src/server/domain/repositories/password-reset.repository';
import {
  UserInviteRepository,
  type CreateUserInviteInput,
  type UserInvite,
} from '../../src/server/domain/repositories/user-invite.repository';
import {
  UserRepository,
  type CreateUserInput,
  type ListUsersInput,
  type UpdateUserInput,
  type UserPage,
} from '../../src/server/domain/repositories/user.repository';
import { CaptchaVerifier } from '../../src/server/application/ports/captcha-verifier';
import { Clock } from '../../src/server/application/ports/clock';
import { EmailSendThrottle } from '../../src/server/application/ports/email-send-throttle';
import { EmailSender, type EmailMessage } from '../../src/server/application/ports/email-sender';
import {
  SessionTokens,
  type GeneratedToken,
} from '../../src/server/application/ports/session-tokens';
import { VerificationCodes } from '../../src/server/application/ports/verification-codes';

// In-memory ports and repositories for application unit tests (docs/14 §14.8).

export class FixedClock extends Clock {
  constructor(private value = new Date('2026-01-01T12:00:00.000Z')) {
    super();
  }
  now(): Date {
    return this.value;
  }
  advance(ms: number): void {
    this.value = new Date(this.value.getTime() + ms);
  }
}

export class FakeVerificationCodes extends VerificationCodes {
  constructor(private readonly code = '123456') {
    super();
  }
  generate(): string {
    return this.code;
  }
  hash(code: string): string {
    return `code:${code}`;
  }
  matches(hash: string, code: string): boolean {
    return hash === this.hash(code);
  }
}

export class FakeSessionTokens extends SessionTokens {
  private counter = 0;
  generate(): GeneratedToken {
    this.counter += 1;
    const token = `token-${this.counter}`;
    return { token, hash: this.hash(token) };
  }
  hash(token: string): string {
    return `hash:${token}`;
  }
}

export class CollectingEmailSender extends EmailSender {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

export class StubCaptchaVerifier extends CaptchaVerifier {
  constructor(private readonly result = true) {
    super();
  }
  get isConfigured(): boolean {
    return true;
  }
  verify(): Promise<boolean> {
    return Promise.resolve(this.result);
  }
}

export class CountingEmailSendThrottle extends EmailSendThrottle {
  private readonly counts = new Map<string, number>();
  constructor(private readonly max = 5) {
    super();
  }
  canSend(email: string): boolean {
    return (this.counts.get(email) ?? 0) < this.max;
  }
  record(email: string): void {
    this.counts.set(email, (this.counts.get(email) ?? 0) + 1);
  }
}

export class InMemoryUserRepository extends UserRepository {
  readonly users: User[] = [];
  private counter = 0;

  constructor(private readonly clock: Clock = new FixedClock()) {
    super();
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.users.find((user) => user.id === id) ?? null);
  }

  findActiveByEmail(email: string): Promise<User | null> {
    return Promise.resolve(this.users.find((user) => user.email === email) ?? null);
  }

  countActive(): Promise<number> {
    return Promise.resolve(this.users.length);
  }

  countActiveAdmins(): Promise<number> {
    return Promise.resolve(
      this.users.filter((user) => user.role === 'ADMIN' && user.deactivatedAt === null).length,
    );
  }

  lockOnboarding(): Promise<void> {
    return Promise.resolve();
  }

  create(input: CreateUserInput): Promise<User> {
    this.counter += 1;
    const user: User = {
      id: `user-${this.counter}`,
      email: input.email,
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      role: input.role,
      language: input.language,
      theme: 'SYSTEM',
      deactivatedAt: null,
      createdAt: this.clock.now(),
    };
    this.users.push(user);
    return Promise.resolve(user);
  }

  list(query: ListUsersInput): Promise<UserPage> {
    const sorted = [...this.users].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const page = sorted.slice(start, start + query.limit);
    const nextCursor = start + query.limit < sorted.length ? String(start + query.limit) : null;
    return Promise.resolve({ items: page, nextCursor });
  }

  update(id: string, input: UpdateUserInput): Promise<User> {
    const index = this.users.findIndex((user) => user.id === id);
    const existing = this.users[index];
    if (existing === undefined) throw new Error(`No user ${id}`);
    const updated: User = {
      ...existing,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.language === undefined ? {} : { language: input.language }),
      ...(input.theme === undefined ? {} : { theme: input.theme }),
      ...(input.passwordHash === undefined ? {} : { passwordHash: input.passwordHash }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.deactivatedAt === undefined ? {} : { deactivatedAt: input.deactivatedAt }),
    };
    this.users[index] = updated;
    return Promise.resolve(updated);
  }
}

export class InMemoryEmailVerificationRepository extends EmailVerificationRepository {
  readonly records = new Map<string, EmailVerification>();
  private counter = 0;

  constructor(private readonly clock: Clock = new FixedClock()) {
    super();
  }

  private key(email: string, purpose: string): string {
    return `${email}:${purpose}`;
  }

  findActive(
    email: string,
    purpose: EmailVerification['purpose'],
  ): Promise<EmailVerification | null> {
    return Promise.resolve(this.records.get(this.key(email, purpose)) ?? null);
  }

  findByTicketHash(ticketHash: string): Promise<EmailVerification | null> {
    return Promise.resolve(
      [...this.records.values()].find((record) => record.ticketHash === ticketHash) ?? null,
    );
  }

  replace(input: CreateEmailVerificationInput): Promise<EmailVerification> {
    this.counter += 1;
    const record: EmailVerification = {
      id: `verification-${this.counter}`,
      email: input.email,
      purpose: input.purpose,
      codeHash: input.codeHash,
      attempts: 0,
      expiresAt: input.expiresAt,
      verifiedAt: null,
      ticketHash: null,
      ticketExpiresAt: null,
      consumedAt: null,
      inviteId: input.inviteId,
      passwordResetId: input.passwordResetId,
      createdAt: this.clock.now(),
    };
    this.records.set(this.key(input.email, input.purpose), record);
    return Promise.resolve(record);
  }

  incrementAttempts(id: string): Promise<number> {
    const record = this.byId(id);
    record.attempts += 1;
    return Promise.resolve(record.attempts);
  }

  issueTicket(id: string, input: IssueTicketInput): Promise<EmailVerification> {
    const record = this.byId(id);
    record.verifiedAt = input.verifiedAt;
    record.ticketHash = input.ticketHash;
    record.ticketExpiresAt = input.ticketExpiresAt;
    return Promise.resolve(record);
  }

  markConsumed(id: string, consumedAt: Date): Promise<void> {
    this.byId(id).consumedAt = consumedAt;
    return Promise.resolve();
  }

  delete(id: string): Promise<void> {
    for (const [key, record] of this.records) {
      if (record.id === id) this.records.delete(key);
    }
    return Promise.resolve();
  }

  deleteExpired(now: Date): Promise<number> {
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (record.expiresAt.getTime() < now.getTime()) {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  private byId(id: string): EmailVerification {
    const found = [...this.records.values()].find((record) => record.id === id);
    if (found === undefined) throw new Error(`No verification ${id}`);
    return found;
  }
}

export class InMemoryUserInviteRepository extends UserInviteRepository {
  readonly invites: Array<UserInvite & { tokenHash: string }> = [];

  findByTokenHash(tokenHash: string): Promise<UserInvite | null> {
    return Promise.resolve(this.invites.find((invite) => invite.tokenHash === tokenHash) ?? null);
  }

  findById(id: string): Promise<UserInvite | null> {
    return Promise.resolve(this.invites.find((invite) => invite.id === id) ?? null);
  }

  markAccepted(id: string, acceptedById: string, acceptedAt: Date): Promise<void> {
    const invite = this.invites.find((candidate) => candidate.id === id);
    if (invite !== undefined) {
      invite.acceptedById = acceptedById;
      invite.acceptedAt = acceptedAt;
    }
    return Promise.resolve();
  }

  create(input: CreateUserInviteInput): Promise<UserInvite> {
    const invite = {
      id: `invite-${this.invites.length + 1}`,
      tokenHash: input.tokenHash,
      role: input.role,
      emailHint: input.emailHint,
      createdById: input.createdById,
      expiresAt: input.expiresAt,
      revokedAt: null,
      acceptedAt: null,
      acceptedById: null,
      createdAt: new Date(0),
    };
    this.invites.push(invite);
    return Promise.resolve(invite);
  }

  listActive(now: Date): Promise<UserInvite[]> {
    return Promise.resolve(
      this.invites.filter(
        (invite) =>
          invite.revokedAt === null &&
          invite.acceptedAt === null &&
          invite.expiresAt.getTime() > now.getTime(),
      ),
    );
  }

  revoke(id: string, revokedAt: Date): Promise<void> {
    const invite = this.invites.find((candidate) => candidate.id === id);
    if (invite !== undefined) invite.revokedAt = revokedAt;
    return Promise.resolve();
  }

  deleteExpired(now: Date): Promise<number> {
    const before = this.invites.length;
    const kept = this.invites.filter((invite) => invite.expiresAt.getTime() >= now.getTime());
    this.invites.length = 0;
    this.invites.push(...kept);
    return Promise.resolve(before - kept.length);
  }
}

export class InMemoryPasswordResetRepository extends PasswordResetRepository {
  readonly resets: Array<PasswordReset & { tokenHash: string }> = [];

  findByTokenHash(tokenHash: string): Promise<PasswordReset | null> {
    return Promise.resolve(this.resets.find((reset) => reset.tokenHash === tokenHash) ?? null);
  }

  findById(id: string): Promise<PasswordReset | null> {
    return Promise.resolve(this.resets.find((reset) => reset.id === id) ?? null);
  }

  markUsed(id: string, usedAt: Date): Promise<void> {
    const reset = this.resets.find((candidate) => candidate.id === id);
    if (reset !== undefined) reset.usedAt = usedAt;
    return Promise.resolve();
  }

  create(input: CreatePasswordResetInput): Promise<PasswordReset> {
    const reset = {
      id: `reset-${this.resets.length + 1}`,
      tokenHash: input.tokenHash,
      userId: input.userId,
      createdById: input.createdById,
      expiresAt: input.expiresAt,
      revokedAt: null,
      usedAt: null,
      createdAt: new Date(0),
    };
    this.resets.push(reset);
    return Promise.resolve(reset);
  }

  revokeAllForUser(userId: string, revokedAt: Date): Promise<number> {
    let revoked = 0;
    for (const reset of this.resets) {
      if (reset.userId === userId && reset.revokedAt === null && reset.usedAt === null) {
        reset.revokedAt = revokedAt;
        revoked += 1;
      }
    }
    return Promise.resolve(revoked);
  }

  deleteExpired(now: Date): Promise<number> {
    const before = this.resets.length;
    const kept = this.resets.filter((reset) => reset.expiresAt.getTime() >= now.getTime());
    this.resets.length = 0;
    this.resets.push(...kept);
    return Promise.resolve(before - kept.length);
  }
}
