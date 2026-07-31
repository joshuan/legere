import { Module } from '@nestjs/common';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import {
  CreateCategory,
  DeleteCategory,
  ListCategories,
  UpdateCategory,
} from '../../application/categories/manage-categories';
import { Clock } from '../../application/ports/clock';
import { SessionTokens } from '../../application/ports/session-tokens';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { CategoryRepository } from '../../domain/repositories/category.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { SessionGuard } from '../auth/session.guard';
import { AdminCategoriesController, CategoriesController } from './categories.controller';

// Categories (docs/06 §6.5): the managed reference list the classifier and the filters share.
@Module({
  controllers: [CategoriesController, AdminCategoriesController],
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
      provide: ListCategories,
      useFactory: (categories: CategoryRepository): ListCategories =>
        new ListCategories(categories),
      inject: [CategoryRepository],
    },
    {
      provide: CreateCategory,
      useFactory: (categories: CategoryRepository): CreateCategory =>
        new CreateCategory(categories),
      inject: [CategoryRepository],
    },
    {
      provide: UpdateCategory,
      useFactory: (categories: CategoryRepository): UpdateCategory =>
        new UpdateCategory(categories),
      inject: [CategoryRepository],
    },
    {
      provide: DeleteCategory,
      useFactory: (
        categories: CategoryRepository,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): DeleteCategory => new DeleteCategory(categories, unitOfWork, clock),
      inject: [CategoryRepository, UnitOfWork, Clock],
    },
  ],
})
export class CategoriesModule {}
