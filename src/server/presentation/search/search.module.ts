import { Module } from '@nestjs/common';
import { EmbeddingProvider } from '../../application/ports/embedding-provider';
import { SearchDocuments } from '../../application/search/search-documents';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { SearchController } from './search.controller';

// Search (docs/06 §6.5): FTS, vectors, and the fusion of the two.
@Module({
  controllers: [SearchController],
  providers: [
    ...sessionGuardProviders,
    {
      provide: SearchDocuments,
      useFactory: (documents: DocumentRepository, embeddings: EmbeddingProvider): SearchDocuments =>
        new SearchDocuments(documents, embeddings),
      inject: [DocumentRepository, EmbeddingProvider],
    },
  ],
})
export class SearchModule {}
