import type { DocumentFieldSchema } from '../../../shared/contracts/document-fields';
import type { FieldExtraction, PageImage } from './document-analyst';

// Receipts have an independent provider and gate; document analysis never routes through this port.
export abstract class ReceiptExtractor {
  abstract get isConfigured(): boolean;
  abstract extractFields(
    schema: DocumentFieldSchema,
    excerpt: string,
    pages?: readonly PageImage[],
  ): Promise<FieldExtraction>;
}
