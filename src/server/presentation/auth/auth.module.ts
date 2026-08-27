import { Module } from '@nestjs/common';
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
import { SecurityEvents } from '../../application/ports/security-events';
import { SessionTokens } from '../../application/ports/session-tokens';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { VerificationCodes } from '../../application/ports/verification-codes';
import { ApiTokenRepository } from '../../domain/repositories/api-token.repository';
import { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserInviteRepository } from '../../domain/repositories/user-invite.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { AuthController } from './auth.controller';
import { sessionGuardProviders } from './session-guard.providers';

// Use cases are framework-free classes, so they are wired with explicit factory providers
// (docs/06 §6.1): no decorators leak into the application layer.
@Module({
  controllers: [AuthController],
  providers: [
    ...sessionGuardProviders,
    {
      provide: Login,
      useFactory: (
        users: UserRepository,
        hasher: PasswordHasher,
        captcha: CaptchaVerifier,
        attempts: LoginAttempts,
        issueSession: IssueSession,
        events: SecurityEvents,
      ): Login => new Login(users, hasher, captcha, attempts, issueSession, events),
      inject: [
        UserRepository,
        PasswordHasher,
        CaptchaVerifier,
        LoginAttempts,
        IssueSession,
        SecurityEvents,
      ],
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
        invites: UserInviteRepository,
        resets: PasswordResetRepository,
        codes: VerificationCodes,
        tokens: SessionTokens,
        clock: Clock,
      ): VerifyEmailCode =>
        new VerifyEmailCode(verifications, invites, resets, codes, tokens, clock),
      inject: [
        EmailVerificationRepository,
        UserInviteRepository,
        PasswordResetRepository,
        VerificationCodes,
        SessionTokens,
        Clock,
      ],
    },
    {
      provide: CompleteRegistration,
      useFactory: (
        users: UserRepository,
        verifications: EmailVerificationRepository,
        invites: UserInviteRepository,
        resets: PasswordResetRepository,
        sessions: SessionRepository,
        apiTokens: ApiTokenRepository,
        hasher: PasswordHasher,
        tokens: SessionTokens,
        issueSession: IssueSession,
        unitOfWork: UnitOfWork,
        clock: Clock,
        events: SecurityEvents,
      ): CompleteRegistration =>
        new CompleteRegistration(
          users,
          verifications,
          invites,
          resets,
          sessions,
          apiTokens,
          hasher,
          tokens,
          issueSession,
          unitOfWork,
          clock,
          events,
        ),
      inject: [
        UserRepository,
        EmailVerificationRepository,
        UserInviteRepository,
        PasswordResetRepository,
        SessionRepository,
        ApiTokenRepository,
        PasswordHasher,
        SessionTokens,
        IssueSession,
        UnitOfWork,
        Clock,
        SecurityEvents,
      ],
    },
  ],
})
export class AuthModule {}
