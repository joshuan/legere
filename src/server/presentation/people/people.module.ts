import { Module } from '@nestjs/common';
import {
  CreatePerson,
  DeletePerson,
  ListPeople,
  UpdatePerson,
} from '../../application/people/manage-people';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { Clock } from '../../application/ports/clock';
import { SessionTokens } from '../../application/ports/session-tokens';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { PersonRepository } from '../../domain/repositories/person.repository';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { AdminPeopleController, PeopleController } from './people.controller';

// People (docs/06 §6.5): the catalogue behind the field, and the little that manages it.
@Module({
  controllers: [PeopleController, AdminPeopleController],
  providers: [
    // The guards and what they need are providers of the module that uses them, the way every other
    // feature module does it (docs/06 §6.5).
    SessionGuard,
    RolesGuard,
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
      provide: ListPeople,
      useFactory: (people: PersonRepository): ListPeople => new ListPeople(people),
      inject: [PersonRepository],
    },
    {
      provide: CreatePerson,
      useFactory: (people: PersonRepository): CreatePerson => new CreatePerson(people),
      inject: [PersonRepository],
    },
    {
      provide: UpdatePerson,
      useFactory: (people: PersonRepository): UpdatePerson => new UpdatePerson(people),
      inject: [PersonRepository],
    },
    {
      provide: DeletePerson,
      useFactory: (people: PersonRepository, clock: Clock): DeletePerson =>
        new DeletePerson(people, clock),
      inject: [PersonRepository, Clock],
    },
  ],
})
export class PeopleModule {}
