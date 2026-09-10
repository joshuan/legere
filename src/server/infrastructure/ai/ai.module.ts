import { Global, Module } from '@nestjs/common';
import { CatalogueAnalyst } from '../../application/ports/catalogue-analyst';
import { DocumentAnalyst } from '../../application/ports/document-analyst';
import { ReceiptExtractor } from '../../application/ports/receipt-extractor';
import { ServiceGates } from '../../application/queue/service-gate';
import { AppConfig } from '../config/app-config';
import { EmbeddingProvider } from '../../application/ports/embedding-provider';
import { PageTranscriber } from '../../application/ports/page-transcriber';
import { OpenAiCompatAnalyst } from './openai-compat-analyst';
import { OpenAiCompatCatalogueAnalyst } from './openai-compat-catalogue-analyst';
import { OpenAiCompatEmbeddings } from './openai-compat-embeddings';
import { OpenAiCompatTranscriber } from './openai-compat-transcriber';

// The optional half of the pipeline (docs/06 §6.5). Both providers are always bound; each reports
// whether it is configured, and the steps that use them skip themselves when it is not — an
// instance with no AI at all is a supported way to run Legere (docs/05 §5.5).
@Global()
@Module({
  providers: [
    { provide: EmbeddingProvider, useClass: OpenAiCompatEmbeddings },
    {
      provide: DocumentAnalyst,
      useFactory: (config: AppConfig, gates: ServiceGates): DocumentAnalyst =>
        new OpenAiCompatAnalyst(config, gates),
      inject: [AppConfig, ServiceGates],
    },
    {
      provide: ReceiptExtractor,
      useFactory: (
        config: AppConfig,
        gates: ServiceGates,
        legacy: DocumentAnalyst,
      ): ReceiptExtractor =>
        config.get('RECEIPT_API_BASE_URL') === '' && config.get('RECEIPT_MODEL') === ''
          ? legacy
          : new OpenAiCompatAnalyst(config, gates, 'receipt-extractor'),
      inject: [AppConfig, ServiceGates, DocumentAnalyst],
    },
    { provide: CatalogueAnalyst, useClass: OpenAiCompatCatalogueAnalyst },
    { provide: PageTranscriber, useClass: OpenAiCompatTranscriber },
  ],
  exports: [
    EmbeddingProvider,
    DocumentAnalyst,
    ReceiptExtractor,
    CatalogueAnalyst,
    PageTranscriber,
  ],
})
export class AiModule {}
