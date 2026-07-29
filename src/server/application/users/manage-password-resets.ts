import type { PasswordResetPreview } from '../../../shared/contracts/auth';
import type { CreatePasswordResetResponse } from '../../../shared/contracts/users';
import { isUserActive } from '../../domain/entities/user';
import { ForbiddenError, NotFoundError } from '../../domain/errors/domain-error';
import {
  isPasswordResetValid,
  type PasswordResetRepository,
} from '../../domain/repositories/password-reset.repository';
import type { UserRepository } from '../../domain/repositories/user.repository';
import type { Clock } from '../ports/clock';
import type { SessionTokens } from '../ports/session-tokens';

// Reset links live a day (docs/03 §3.3.5).
const RESET_TTL_MS = 24 * 60 * 60 * 1000;

// POST /api/admin/users/:id/password-reset (docs/08 §8.1.6). There is no self-service recovery: an
// admin generates the link and hands it over out of band. Like invites, the URL appears once.
export class CreatePasswordReset {
  constructor(
    private readonly users: UserRepository,
    private readonly resets: PasswordResetRepository,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
    private readonly appBaseUrl: string,
  ) {}

  async execute(userId: string, createdById: string): Promise<CreatePasswordResetResponse> {
    const user = await this.users.findById(userId);
    if (user === null) throw new NotFoundError('USER_NOT_FOUND', 'User not found');

    // A blocked account must not be recoverable through a reset link — reactivate it first.
    if (!isUserActive(user)) {
      throw new ForbiddenError('This account is deactivated');
    }

    const { token, hash } = this.tokens.generate();
    const expiresAt = new Date(this.clock.now().getTime() + RESET_TTL_MS);
    await this.resets.create({ userId, tokenHash: hash, createdById, expiresAt });

    return {
      url: new URL(`/reset/${token}`, this.appBaseUrl).toString(),
      expiresAt: expiresAt.toISOString(),
    };
  }
}

// GET /api/password-resets/:token — public landing page data. The address is masked: enough for the
// holder of the link to recognise their own account, not enough to harvest addresses.
export class PreviewPasswordReset {
  constructor(
    private readonly resets: PasswordResetRepository,
    private readonly users: UserRepository,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
  ) {}

  async execute(token: string): Promise<PasswordResetPreview> {
    const reset = await this.resets.findByTokenHash(this.tokens.hash(token));
    if (reset === null) throw new NotFoundError('NOT_FOUND', 'Password reset not found');

    const user = await this.users.findById(reset.userId);
    const valid =
      user !== null && isUserActive(user) && isPasswordResetValid(reset, this.clock.now());

    return {
      email: maskEmail(user?.email ?? ''),
      expiresAt: reset.expiresAt.toISOString(),
      valid,
    };
  }
}

// a***n@legere.local — keeps the first and last character of the local part.
export function maskEmail(email: string): string {
  const [localPart, domain] = email.split('@');
  if (localPart === undefined || domain === undefined || localPart === '') return '';
  if (localPart.length <= 2) return `${localPart.slice(0, 1)}***@${domain}`;
  return `${localPart.slice(0, 1)}***${localPart.slice(-1)}@${domain}`;
}
