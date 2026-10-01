import { Module } from '@nestjs/common';
import { OAuth } from '../../application/auth/oauth';
import { OAuthRepository } from '../../domain/repositories/oauth.repository';
import { ApiTokenRepository } from '../../domain/repositories/api-token.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { Clock } from '../../application/ports/clock';
import { SessionTokens } from '../../application/ports/session-tokens';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { AppConfig } from '../../infrastructure/config/app-config';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { OAuthController, OAuthGrantsController } from './oauth.controller';

@Module({
  controllers: [OAuthController, OAuthGrantsController],
  providers: [
    ...sessionGuardProviders,
    {
      provide: OAuth,
      useFactory: (
        repository: OAuthRepository,
        tokens: ApiTokenRepository,
        users: UserRepository,
        secrets: SessionTokens,
        clock: Clock,
        unitOfWork: UnitOfWork,
        config: AppConfig,
      ) =>
        new OAuth(
          repository,
          tokens,
          users,
          secrets,
          clock,
          unitOfWork,
          config.get('APP_BASE_URL'),
        ),
      inject: [
        OAuthRepository,
        ApiTokenRepository,
        UserRepository,
        SessionTokens,
        Clock,
        UnitOfWork,
        AppConfig,
      ],
    },
  ],
})
export class OAuthModule {}
