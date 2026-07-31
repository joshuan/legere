import { Global, Module } from '@nestjs/common';
import { DocumentClassifier } from '../../application/ports/document-classifier';
import { EmbeddingProvider } from '../../application/ports/embedding-provider';
import { OpenAiCompatClassifier } from './openai-compat-classifier';
import { OpenAiCompatEmbeddings } from './openai-compat-embeddings';

// The optional half of the pipeline (docs/06 §6.5). Both providers are always bound; each reports
// whether it is configured, and the steps that use them skip themselves when it is not — an
// instance with no AI at all is a supported way to run Legere (docs/05 §5.5).
@Global()
@Module({
  providers: [
    { provide: EmbeddingProvider, useClass: OpenAiCompatEmbeddings },
    { provide: DocumentClassifier, useClass: OpenAiCompatClassifier },
  ],
  exports: [EmbeddingProvider, DocumentClassifier],
})
export class AiModule {}
