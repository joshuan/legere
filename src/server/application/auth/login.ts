import type { UserDto } from '../../../shared/contracts/auth';
import { isUserActive } from '../../domain/entities/user';
import {
  AuthFlowError,
  ForbiddenError,
  InvalidCredentialsError,
  RateLimitedError,
} from '../../domain/errors/domain-error';
import type { UserRepository } from '../../domain/repositories/user.repository';
import type { CaptchaVerifier } from '../ports/captcha-verifier';
import type { LoginAttempts } from '../ports/login-attempts';
import type { PasswordHasher } from '../ports/password-hasher';
import { toUserDto } from './complete-registration';
import type { IssueSession } from './issue-session';

export type LoginInput = {
  email: string;
  password: string;
  captchaToken?: string | undefined;
  ip?: string | undefined;
  userAgent: string | null;
};

export type LoginResult = {
  user: UserDto;
  sessionToken: string;
};

// Any string works; it exists only to give the "no such user" branch the same Argon2 cost as a real
// verification, so response time does not reveal whether the address exists (docs/08 §8.1.4).
const DUMMY_PASSWORD = 'dummy-password-for-constant-time-login';

// POST /api/auth/login (docs/08 §8.1.4). Login never creates an account; a successful attempt always
// gets a brand-new session, which is what makes the flow immune to session fixation (docs/08 §8.2).
export class Login {
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly captcha: CaptchaVerifier,
    private readonly attempts: LoginAttempts,
    private readonly issueSession: IssueSession,
  ) {}

  async execute(input: LoginInput): Promise<LoginResult> {
    if (!(await this.captcha.verify(input.captchaToken, input.ip))) {
      throw new AuthFlowError('CAPTCHA_FAILED', 'CAPTCHA verification failed');
    }

    const retryAfterMs = this.attempts.retryAfterMs(input.email);
    if (retryAfterMs > 0) {
      throw new RateLimitedError('RATE_LIMITED', 'Too many failed attempts; try again later');
    }

    const user = await this.users.findActiveByEmail(input.email);
    if (user === null) {
      // Spend the same time as a real verification would, then answer identically.
      await this.hasher.verify(await this.dummy(), input.password);
      this.attempts.recordFailure(input.email);
      throw new InvalidCredentialsError();
    }

    if (!(await this.hasher.verify(user.passwordHash, input.password))) {
      this.attempts.recordFailure(input.email);
      throw new InvalidCredentialsError();
    }

    // Correct credentials but the account is blocked: a distinct answer is fine here, since the
    // caller has already proven they know the password (docs/07 §7.2 lists 403 for a deactivated
    // user). Deactivation also revoked the sessions, so nothing else needs undoing.
    if (!isUserActive(user)) {
      throw new ForbiddenError('This account is deactivated');
    }

    this.attempts.clear(input.email);
    const { token } = await this.issueSession.execute(user.id, input.userAgent);
    return { user: toUserDto(user), sessionToken: token };
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= this.hasher.hash(DUMMY_PASSWORD);
    return this.dummyHash;
  }
}
