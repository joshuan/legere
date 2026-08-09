import type { AdminUserDto, ListUsersResponse } from '../../../shared/contracts/users';
import type { UserRole } from '../../../shared/contracts/enums';
import { isUserActive, type User } from '../../domain/entities/user';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { ApiTokenRepository } from '../../domain/repositories/api-token.repository';
import type { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import type { SessionRepository } from '../../domain/repositories/session.repository';
import type { UserRepository } from '../../domain/repositories/user.repository';
import type { Clock } from '../ports/clock';
import type { SecurityEvents } from '../ports/security-events';
import type { UnitOfWork } from '../ports/unit-of-work';

// GET /api/admin/users — cursor-paginated, createdAt ascending (docs/07 §7.3).
export class ListUsers {
  constructor(private readonly users: UserRepository) {}

  async execute(query: { limit: number; cursor?: string | undefined }): Promise<ListUsersResponse> {
    const page = await this.users.list(query);
    return { items: page.items.map(toAdminUserDto), nextCursor: page.nextCursor };
  }
}

// PATCH /api/admin/users/:id — role change, guarded so the instance always keeps an admin who can
// actually sign in (docs/03 §3.3.1).
export class ChangeUserRole {
  constructor(
    private readonly users: UserRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly events: SecurityEvents,
  ) {}

  async execute(userId: string, role: UserRole, actorId: string): Promise<AdminUserDto> {
    const { user, fromRole } = await this.unitOfWork.run(async (tx) => {
      const existing = await requireUser(this.users, userId, tx);
      if (existing.role === role) return { user: existing, fromRole: null };

      if (role !== 'ADMIN') await assertNotLastAdmin(this.users, existing, tx);

      return { user: await this.users.update(userId, { role }, tx), fromRole: existing.role };
    });

    // Nothing is recorded when nothing moved: a journal of no-ops is a journal nobody reads.
    if (fromRole !== null) {
      this.events.record({
        event: 'role.changed',
        actor: { userId: actorId },
        target: { userId },
        detail: { fromRole, role },
      });
    }
    return toAdminUserDto(user);
  }
}

// POST /api/admin/users/:id/deactivate — blocks login, kills sessions and API tokens, and
// invalidates any pending reset link so a blocked account cannot be recovered behind the admin's
// back (docs/03 §3.3.1).
export class DeactivateUser {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly apiTokens: ApiTokenRepository,
    private readonly resets: PasswordResetRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: SecurityEvents,
  ) {}

  async execute(userId: string, actorId: string): Promise<AdminUserDto> {
    const now = this.clock.now();
    const { user, sessions } = await this.unitOfWork.run(async (tx) => {
      const existing = await requireUser(this.users, userId, tx);
      if (!isUserActive(existing)) return { user: existing, sessions: null };

      await assertNotLastAdmin(this.users, existing, tx);

      const updated = await this.users.update(userId, { deactivatedAt: now }, tx);
      const revoked = await this.sessions.revokeAllForUser(userId, now, tx);
      // A blocked account keeps no credentials, and a token is a credential (docs/03 §3.3.22).
      await this.apiTokens.revokeAllForUser(userId, now, tx);
      await this.resets.revokeAllForUser(userId, now, tx);
      return { user: updated, sessions: revoked };
    });

    if (sessions !== null) {
      this.events.record({
        event: 'account.deactivated',
        actor: { userId: actorId },
        target: { userId },
        detail: { sessions },
      });
    }
    return toAdminUserDto(user);
  }
}

// POST /api/admin/users/:id/reactivate — the inverse; sessions are not restored, the user signs in
// again.
export class ReactivateUser {
  constructor(
    private readonly users: UserRepository,
    private readonly events: SecurityEvents,
  ) {}

  async execute(userId: string, actorId: string): Promise<AdminUserDto> {
    const user = await requireUser(this.users, userId);
    if (isUserActive(user)) return toAdminUserDto(user);

    const updated = await this.users.update(userId, { deactivatedAt: null });
    this.events.record({
      event: 'account.reactivated',
      actor: { userId: actorId },
      target: { userId },
      detail: { role: updated.role },
    });
    return toAdminUserDto(updated);
  }
}

// POST /api/admin/users/:id/revoke-sessions — signs the user out everywhere without blocking them.
export class RevokeUserSessions {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly clock: Clock,
    private readonly events: SecurityEvents,
  ) {}

  async execute(userId: string, actorId: string): Promise<{ revoked: number }> {
    await requireUser(this.users, userId);
    const revoked = await this.sessions.revokeAllForUser(userId, this.clock.now());
    this.events.record({
      event: 'session.revoked',
      actor: { userId: actorId },
      target: { userId },
      detail: { sessions: revoked },
    });
    return { revoked };
  }
}

async function requireUser(users: UserRepository, userId: string, tx?: unknown): Promise<User> {
  const user = await users.findById(userId, tx);
  if (user === null) throw new NotFoundError('USER_NOT_FOUND', 'User not found');
  return user;
}

// 🔒 The last active, non-deactivated admin cannot be demoted or blocked (docs/03 §3.3.1). Read
// inside the caller's transaction so two concurrent demotions cannot both see a second admin.
async function assertNotLastAdmin(users: UserRepository, user: User, tx?: unknown): Promise<void> {
  if (user.role !== 'ADMIN' || !isUserActive(user)) return;
  if ((await users.countActiveAdmins(tx)) <= 1) {
    throw new ConflictError('LAST_ADMIN', 'The last administrator cannot be demoted or blocked');
  }
}

export function toAdminUserDto(user: User): AdminUserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    deactivatedAt: user.deactivatedAt === null ? null : user.deactivatedAt.toISOString(),
    createdAt: user.createdAt.toISOString(),
  };
}
