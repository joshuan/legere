import { Module } from '@nestjs/common';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import {
  AddCollectionItem,
  CreateCollection,
  DeleteCollection,
  GetCollection,
  ListCollections,
  ListCollectionShares,
  RemoveCollectionItem,
  RevokeShare,
  ShareCollection,
  UpdateCollection,
} from '../../application/collections/manage-collections';
import { LookupUsers } from '../../application/collections/lookup-users';
import { Clock } from '../../application/ports/clock';
import { SessionTokens } from '../../application/ports/session-tokens';
import { CollectionRepository } from '../../domain/repositories/collection.repository';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { SessionGuard } from '../auth/session.guard';
import { CollectionsController, UserLookupController } from './collections.controller';

// Collections and sharing (docs/06 §6.5).
@Module({
  controllers: [CollectionsController, UserLookupController],
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
      provide: ListCollections,
      useFactory: (collections: CollectionRepository): ListCollections =>
        new ListCollections(collections),
      inject: [CollectionRepository],
    },
    {
      provide: CreateCollection,
      useFactory: (collections: CollectionRepository): CreateCollection =>
        new CreateCollection(collections),
      inject: [CollectionRepository],
    },
    {
      provide: GetCollection,
      useFactory: (
        collections: CollectionRepository,
        documents: DocumentRepository,
      ): GetCollection => new GetCollection(collections, documents),
      inject: [CollectionRepository, DocumentRepository],
    },
    {
      provide: UpdateCollection,
      useFactory: (collections: CollectionRepository): UpdateCollection =>
        new UpdateCollection(collections),
      inject: [CollectionRepository],
    },
    {
      provide: DeleteCollection,
      useFactory: (collections: CollectionRepository, clock: Clock): DeleteCollection =>
        new DeleteCollection(collections, clock),
      inject: [CollectionRepository, Clock],
    },
    {
      provide: AddCollectionItem,
      useFactory: (
        collections: CollectionRepository,
        documents: DocumentRepository,
      ): AddCollectionItem => new AddCollectionItem(collections, documents),
      inject: [CollectionRepository, DocumentRepository],
    },
    {
      provide: RemoveCollectionItem,
      useFactory: (collections: CollectionRepository): RemoveCollectionItem =>
        new RemoveCollectionItem(collections),
      inject: [CollectionRepository],
    },
    {
      provide: ListCollectionShares,
      useFactory: (collections: CollectionRepository): ListCollectionShares =>
        new ListCollectionShares(collections),
      inject: [CollectionRepository],
    },
    {
      provide: ShareCollection,
      useFactory: (collections: CollectionRepository, users: UserRepository): ShareCollection =>
        new ShareCollection(collections, users),
      inject: [CollectionRepository, UserRepository],
    },
    {
      provide: RevokeShare,
      useFactory: (collections: CollectionRepository, clock: Clock): RevokeShare =>
        new RevokeShare(collections, clock),
      inject: [CollectionRepository, Clock],
    },
    {
      provide: LookupUsers,
      useFactory: (users: UserRepository): LookupUsers => new LookupUsers(users),
      inject: [UserRepository],
    },
  ],
})
export class CollectionsModule {}
