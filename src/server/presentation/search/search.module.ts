import { Module } from '@nestjs/common';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { Clock } from '../../application/ports/clock';
import { EmbeddingProvider } from '../../application/ports/embedding-provider';
import { SessionTokens } from '../../application/ports/session-tokens';
import { SearchDocuments } from '../../application/search/search-documents';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { SessionGuard } from '../auth/session.guard';
import { SearchController } from './search.controller';

// Search (docs/06 §6.5): FTS, vectors, and the fusion of the two.
@Module({
  controllers: [SearchController],
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
      provide: SearchDocuments,
      useFactory: (
        documents: DocumentRepository,
        embeddings: EmbeddingProvider,
      ): SearchDocuments => new SearchDocuments(documents, embeddings),
      inject: [DocumentRepository, EmbeddingProvider],
    },
  ],
})
export class SearchModule {}
