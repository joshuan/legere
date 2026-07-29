import { Module } from '@nestjs/common';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { Clock } from '../../application/ports/clock';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { SessionTokens } from '../../application/ports/session-tokens';
import {
  CreateInvite,
  ListInvites,
  PreviewInvite,
  RevokeInvite,
} from '../../application/users/manage-invites';
import { GetMe, UpdateMe } from '../../application/users/manage-me';
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
import { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserInviteRepository } from '../../domain/repositories/user-invite.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { SessionGuard } from '../auth/session.guard';
import { AdminInvitesController } from './admin-invites.controller';
import { AdminUsersController } from './admin-users.controller';
import { InvitesController } from './invites.controller';
import { MeController } from './me.controller';
import { PasswordResetsController } from './password-resets.controller';

// Users, invites and password resets (docs/06 §6.5). Use cases are framework-free, so each is bound
// with an explicit factory provider.
@Module({
  controllers: [
    MeController,
    InvitesController,
    PasswordResetsController,
    AdminInvitesController,
    AdminUsersController,
  ],
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
        resets: PasswordResetRepository,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): DeactivateUser => new DeactivateUser(users, sessions, resets, unitOfWork, clock),
      inject: [UserRepository, SessionRepository, PasswordResetRepository, UnitOfWork, Clock],
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
