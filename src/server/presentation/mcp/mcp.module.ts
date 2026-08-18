import { Module } from '@nestjs/common';
import { ArchiveTools } from '../../application/mcp/archive-tools';
import { EmbeddingProvider } from '../../application/ports/embedding-provider';
import { SearchDocuments } from '../../application/search/search-documents';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { McpController } from './mcp.controller';

// The archive as a tool set (docs/07 §7.3a, ADR-024): the tools are the search and the document
// reads this API already serves, built on the same use cases the browser talks to — the search is
// wired here rather than imported, exactly as `SearchModule` wires its own, so neither module owns
// the other's lifetime.
@Module({
  controllers: [McpController],
  providers: [
    ...sessionGuardProviders,
    {
      provide: SearchDocuments,
      useFactory: (documents: DocumentRepository, embeddings: EmbeddingProvider): SearchDocuments =>
        new SearchDocuments(documents, embeddings),
      inject: [DocumentRepository, EmbeddingProvider],
    },
    {
      provide: ArchiveTools,
      useFactory: (
        search: SearchDocuments,
        documents: DocumentRepository,
        config: AppConfig,
      ): ArchiveTools => new ArchiveTools(search, documents, config.get('APP_BASE_URL')),
      inject: [SearchDocuments, DocumentRepository, AppConfig],
    },
  ],
})
export class McpModule {}
