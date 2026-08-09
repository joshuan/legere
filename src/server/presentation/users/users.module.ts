import { Module } from '@nestjs/common';
import { AuthenticateApiToken } from '../../application/auth/authenticate-api-token';
import { ChangePassword } from '../../application/auth/change-password';
import { Clock } from '../../application/ports/clock';
import { PasswordHasher } from '../../application/ports/password-hasher';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { SessionTokens } from '../../application/ports/session-tokens';
import {
  CreateInvite,
  ListInvites,
  PreviewInvite,
  RevokeInvite,
} from '../../application/users/manage-invites';
import {
  CreateApiToken,
  ListApiTokens,
  RevokeApiToken,
} from '../../application/users/manage-api-tokens';
import { GetMe, UpdateMe } from '../../application/users/manage-me';
import { ListMySessions, RevokeMySession } from '../../application/users/manage-sessions';
import {
  CreatePasswordReset,
  PreviewPasswordReset,
} from '../../application/users/manage-password-resets';
import {
  ChangeUserRole,
  DeactivateUser,
  ListUsers,
  ReactivateUser,
  RevokeUserSessions,
} from '../../application/users/manage-users';
import { ApiTokenRepository } from '../../domain/repositories/api-token.repository';
import { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserInviteRepository } from '../../domain/repositories/user-invite.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { AdminInvitesController } from './admin-invites.controller';
import { AdminUsersController } from './admin-users.controller';
import { InvitesController } from './invites.controller';
import { MeApiTokensController } from './me-api-tokens.controller';
import { MeSessionsController } from './me-sessions.controller';
import { MeController } from './me.controller';
import { PasswordResetsController } from './password-resets.controller';

// Users, invites and password resets (docs/06 §6.5). Use cases are framework-free, so each is bound
// with an explicit factory provider.
@Module({
  controllers: [
    MeController,
    MeApiTokensController,
    MeSessionsController,
    InvitesController,
    PasswordResetsController,
    AdminInvitesController,
    AdminUsersController,
  ],
  providers: [
    ...sessionGuardProviders,
    {
      provide: AuthenticateApiToken,
      useFactory: (
        apiTokens: ApiTokenRepository,
        users: UserRepository,
        tokens: SessionTokens,
        clock: Clock,
      ): AuthenticateApiToken => new AuthenticateApiToken(apiTokens, users, tokens, clock),
      inject: [ApiTokenRepository, UserRepository, SessionTokens, Clock],
    },
    {
      provide: CreateApiToken,
      useFactory: (
        apiTokens: ApiTokenRepository,
        tokens: SessionTokens,
        clock: Clock,
        config: AppConfig,
      ): CreateApiToken =>
        new CreateApiToken(apiTokens, tokens, clock, config.get('API_TOKEN_TTL_DAYS')),
      inject: [ApiTokenRepository, SessionTokens, Clock, AppConfig],
    },
    {
      provide: ListApiTokens,
      useFactory: (apiTokens: ApiTokenRepository, clock: Clock): ListApiTokens =>
        new ListApiTokens(apiTokens, clock),
      inject: [ApiTokenRepository, Clock],
    },
    {
      provide: RevokeApiToken,
      useFactory: (apiTokens: ApiTokenRepository, clock: Clock): RevokeApiToken =>
        new RevokeApiToken(apiTokens, clock),
      inject: [ApiTokenRepository, Clock],
    },
    {
      provide: CreateInvite,
      useFactory: (
        invites: UserInviteRepository,
        tokens: SessionTokens,
        clock: Clock,
        config: AppConfig,
      ): CreateInvite => new CreateInvite(invites, tokens, clock, config.get('APP_BASE_URL')),
      inject: [UserInviteRepository, SessionTokens, Clock, AppConfig],
    },
    {
      provide: ListInvites,
      useFactory: (invites: UserInviteRepository, clock: Clock): ListInvites =>
        new ListInvites(invites, clock),
      inject: [UserInviteRepository, Clock],
    },
    {
      provide: RevokeInvite,
      useFactory: (invites: UserInviteRepository, clock: Clock): RevokeInvite =>
        new RevokeInvite(invites, clock),
      inject: [UserInviteRepository, Clock],
    },
    {
      provide: PreviewInvite,
      useFactory: (
        invites: UserInviteRepository,
        tokens: SessionTokens,
        clock: Clock,
      ): PreviewInvite => new PreviewInvite(invites, tokens, clock),
      inject: [UserInviteRepository, SessionTokens, Clock],
    },
    {
      provide: CreatePasswordReset,
      useFactory: (
        users: UserRepository,
        resets: PasswordResetRepository,
        tokens: SessionTokens,
        clock: Clock,
        config: AppConfig,
      ): CreatePasswordReset =>
        new CreatePasswordReset(users, resets, tokens, clock, config.get('APP_BASE_URL')),
      inject: [UserRepository, PasswordResetRepository, SessionTokens, Clock, AppConfig],
    },
    { provide: GetMe, useFactory: (): GetMe => new GetMe() },
    {
      provide: UpdateMe,
      useFactory: (users: UserRepository): UpdateMe => new UpdateMe(users),
      inject: [UserRepository],
    },
    {
      provide: ChangePassword,
      useFactory: (
        users: UserRepository,
        sessions: SessionRepository,
        hasher: PasswordHasher,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): ChangePassword => new ChangePassword(users, sessions, hasher, unitOfWork, clock),
      inject: [UserRepository, SessionRepository, PasswordHasher, UnitOfWork, Clock],
    },
    {
      provide: ListMySessions,
      useFactory: (sessions: SessionRepository, clock: Clock): ListMySessions =>
        new ListMySessions(sessions, clock),
      inject: [SessionRepository, Clock],
    },
    {
      provide: RevokeMySession,
      useFactory: (sessions: SessionRepository, clock: Clock): RevokeMySession =>
        new RevokeMySession(sessions, clock),
      inject: [SessionRepository, Clock],
    },
    {
      provide: ListUsers,
      useFactory: (users: UserRepository): ListUsers => new ListUsers(users),
      inject: [UserRepository],
    },
    {
      provide: ChangeUserRole,
      useFactory: (users: UserRepository, unitOfWork: UnitOfWork): ChangeUserRole =>
        new ChangeUserRole(users, unitOfWork),
      inject: [UserRepository, UnitOfWork],
    },
    {
      provide: DeactivateUser,
      useFactory: (
        users: UserRepository,
        sessions: SessionRepository,
        apiTokens: ApiTokenRepository,
        resets: PasswordResetRepository,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): DeactivateUser =>
        new DeactivateUser(users, sessions, apiTokens, resets, unitOfWork, clock),
      inject: [
        UserRepository,
        SessionRepository,
        ApiTokenRepository,
        PasswordResetRepository,
        UnitOfWork,
        Clock,
      ],
    },
    {
      provide: ReactivateUser,
      useFactory: (users: UserRepository): ReactivateUser => new ReactivateUser(users),
      inject: [UserRepository],
    },
    {
      provide: RevokeUserSessions,
      useFactory: (
        users: UserRepository,
        sessions: SessionRepository,
        clock: Clock,
      ): RevokeUserSessions => new RevokeUserSessions(users, sessions, clock),
      inject: [UserRepository, SessionRepository, Clock],
    },
    {
      provide: PreviewPasswordReset,
      useFactory: (
        resets: PasswordResetRepository,
        users: UserRepository,
        tokens: SessionTokens,
        clock: Clock,
      ): PreviewPasswordReset => new PreviewPasswordReset(resets, users, tokens, clock),
      inject: [PasswordResetRepository, UserRepository, SessionTokens, Clock],
    },
  ],
})
export class UsersModule {}
