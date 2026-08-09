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
//
// 🔒 The password is checked before anything is refused, and the per-address backoff of docs/08 §8.4
// applies to failures only. Gating on the streak first made knowing an address enough to keep its
// owner out for ever: five wrong guesses, then one request every fifteen minutes, and the right
// password never got looked at. The cost of the inversion is that an unauthenticated caller can
// spend one Argon2 verification per request; that is bounded by the hashing gate the hasher runs
// behind (`ConcurrencyGate`) and by the per-IP throttler in front of this controller.
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

    const user = await this.users.findActiveByEmail(input.email);
    // Exactly one verification per attempt, whichever branch this is: an address nobody registered
    // is checked against a dummy hash, so neither the answer nor the time it took says whether the
    // account exists (docs/08 §8.1.4). The streak is not consulted before this line — reading it
    // here would answer some attempts without hashing and hand back the timing oracle.
    const passwordHash = user?.passwordHash ?? (await this.dummy());
    const matches = await this.hasher.verify(passwordHash, input.password);

    if (user === null || !matches) {
      this.attempts.recordFailure(input.email);
      // Only a failure is delayed, and the delay is the same for an address that exists and one
      // that does not — the failure was recorded either way, so both reach the window together.
      if (this.attempts.retryAfterMs(input.email) > 0) {
        throw new RateLimitedError('RATE_LIMITED', 'Too many failed attempts; try again later');
      }
      throw new InvalidCredentialsError();
    }

    // Correct credentials but the account is blocked: a distinct answer is fine here, since the
    // caller has already proven they know the password (docs/07 §7.2 lists 403 for a deactivated
    // user). Deactivation also revoked the sessions, so nothing else needs undoing.
    if (!isUserActive(user)) {
      throw new ForbiddenError('This account is deactivated');
    }

    // Whatever the streak said. A correct password is the proof the backoff exists to wait for.
    this.attempts.clear(input.email);
    const { token } = await this.issueSession.execute(user.id, input.userAgent);
    return { user: toUserDto(user), sessionToken: token };
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= this.hasher.hash(DUMMY_PASSWORD);
    return this.dummyHash;
  }
}
