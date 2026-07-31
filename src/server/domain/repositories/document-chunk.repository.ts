import type { TransactionHandle } from '../../application/ports/unit-of-work';

export type NewDocumentChunk = {
  index: number;
  content: string;
  charCount: number;
  embedding: number[];
};

export abstract class DocumentChunkRepository {
  // Chunks are derived data with no history: (re)vectorization deletes them all and inserts the new
  // set in one transaction (docs/03 §3.3.11), so a document is never half-vectorized and search
  // never sees a mix of two runs.
  abstract replaceForDocument(
    documentId: string,
    chunks: readonly NewDocumentChunk[],
    tx?: TransactionHandle,
  ): Promise<void>;

  abstract countForDocument(documentId: string, tx?: TransactionHandle): Promise<number>;
}
