import { Module } from '@nestjs/common';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { CompleteRegistration } from '../../application/auth/complete-registration';
import { GetOnboardingStatus } from '../../application/auth/get-onboarding-status';
import { IssueSession } from '../../application/auth/issue-session';
import { Login } from '../../application/auth/login';
import { Logout } from '../../application/auth/logout';
import { StartRegistration } from '../../application/auth/start-registration';
import { VerifyEmailCode } from '../../application/auth/verify-email-code';
import { CaptchaVerifier } from '../../application/ports/captcha-verifier';
import { Clock } from '../../application/ports/clock';
import { EmailSendThrottle } from '../../application/ports/email-send-throttle';
import { EmailSender } from '../../application/ports/email-sender';
import { LoginAttempts } from '../../application/ports/login-attempts';
import { PasswordHasher } from '../../application/ports/password-hasher';
import { SessionTokens } from '../../application/ports/session-tokens';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { VerificationCodes } from '../../application/ports/verification-codes';
import { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserInviteRepository } from '../../domain/repositories/user-invite.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { AuthController } from './auth.controller';
import { SessionGuard } from './session.guard';

// Use cases are framework-free classes, so they are wired with explicit factory providers
// (docs/06 §6.1): no decorators leak into the application layer.
@Module({
  controllers: [AuthController],
  providers: [
    SessionGuard,
    {
      provide: AuthenticateSession,
      useFactory: (
        sessions: SessionRepository,
        users: UserRepository,
        tokens: SessionTokens,
        clock: Clock,
      ): AuthenticateSession => new AuthenticateSession(sessions, users, tokens, clock),
      inject: [SessionRepository, UserRepository, SessionTokens, Clock],
    },
    {
      provide: Login,
      useFactory: (
        users: UserRepository,
        hasher: PasswordHasher,
        captcha: CaptchaVerifier,
        attempts: LoginAttempts,
        issueSession: IssueSession,
      ): Login => new Login(users, hasher, captcha, attempts, issueSession),
      inject: [UserRepository, PasswordHasher, CaptchaVerifier, LoginAttempts, IssueSession],
    },
    {
      provide: Logout,
      useFactory: (sessions: SessionRepository, clock: Clock): Logout =>
        new Logout(sessions, clock),
      inject: [SessionRepository, Clock],
    },
    {
      provide: IssueSession,
      useFactory: (
        sessions: SessionRepository,
        tokens: SessionTokens,
        clock: Clock,
        config: AppConfig,
      ): IssueSession => new IssueSession(sessions, tokens, clock, config.get('SESSION_TTL_DAYS')),
      inject: [SessionRepository, SessionTokens, Clock, AppConfig],
    },
    {
      provide: GetOnboardingStatus,
      useFactory: (users: UserRepository): GetOnboardingStatus => new GetOnboardingStatus(users),
      inject: [UserRepository],
    },
    {
      provide: StartRegistration,
      useFactory: (
        users: UserRepository,
        verifications: EmailVerificationRepository,
        invites: UserInviteRepository,
        resets: PasswordResetRepository,
        codes: VerificationCodes,
        tokens: SessionTokens,
        email: EmailSender,
        captcha: CaptchaVerifier,
        throttle: EmailSendThrottle,
        clock: Clock,
        config: AppConfig,
      ): StartRegistration =>
        new StartRegistration(
          users,
          verifications,
          invites,
          resets,
          codes,
          tokens,
          email,
          captcha,
          throttle,
          clock,
          config.get('APP_BASE_URL'),
        ),
      inject: [
        UserRepository,
        EmailVerificationRepository,
        UserInviteRepository,
        PasswordResetRepository,
        VerificationCodes,
        SessionTokens,
        EmailSender,
        CaptchaVerifier,
        EmailSendThrottle,
        Clock,
        AppConfig,
      ],
    },
    {
      provide: VerifyEmailCode,
      useFactory: (
        verifications: EmailVerificationRepository,
        codes: VerificationCodes,
        tokens: SessionTokens,
        clock: Clock,
      ): VerifyEmailCode => new VerifyEmailCode(verifications, codes, tokens, clock),
      inject: [EmailVerificationRepository, VerificationCodes, SessionTokens, Clock],
    },
    {
      provide: CompleteRegistration,
      useFactory: (
        users: UserRepository,
        verifications: EmailVerificationRepository,
        invites: UserInviteRepository,
        resets: PasswordResetRepository,
        sessions: SessionRepository,
        hasher: PasswordHasher,
        tokens: SessionTokens,
        issueSession: IssueSession,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): CompleteRegistration =>
        new CompleteRegistration(
          users,
          verifications,
          invites,
          resets,
          sessions,
          hasher,
          tokens,
          issueSession,
          unitOfWork,
          clock,
        ),
      inject: [
        UserRepository,
        EmailVerificationRepository,
        UserInviteRepository,
        PasswordResetRepository,
        SessionRepository,
        PasswordHasher,
        SessionTokens,
        IssueSession,
        UnitOfWork,
        Clock,
      ],
    },
  ],
})
export class AuthModule {}
