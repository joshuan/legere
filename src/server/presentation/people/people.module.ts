import { Module } from '@nestjs/common';
import {
  CreatePerson,
  DeletePerson,
  ListPeople,
  MergePeople,
  UpdatePerson,
} from '../../application/people/manage-people';
import { Clock } from '../../application/ports/clock';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { PersonRepository } from '../../domain/repositories/person.repository';
import { RolesGuard } from '../auth/roles.guard';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { AdminPeopleController, PeopleController } from './people.controller';

// People (docs/06 §6.5): the catalogue behind the field, and the little that manages it.
@Module({
  controllers: [PeopleController, AdminPeopleController],
  providers: [
    // The guards and what they need are providers of the module that uses them, the way every other
    // feature module does it (docs/06 §6.5).
    ...sessionGuardProviders,
    RolesGuard,
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
      provide: MergePeople,
      useFactory: (people: PersonRepository, unitOfWork: UnitOfWork, clock: Clock): MergePeople =>
        new MergePeople(people, unitOfWork, clock),
      inject: [PersonRepository, UnitOfWork, Clock],
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
