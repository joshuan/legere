import type { TransactionHandle } from '../../application/ports/unit-of-work';

export type NewDocumentChunk = {
  index: number;
  content: string;
  charCount: number;
  embedding: number[];
  // Which model produced the vector beside it (docs/03 §3.3.11): a distance between two models'
  // vectors is a number with no meaning, and this is what makes a half-finished switch visible.
  model: string;
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

  // How many vectors the archive holds and which model made them (docs/07 §7.3). One grouped count
  // for the admin panel; a chunk written before the column existed answers with a null model.
  abstract countByModel(
    tx?: TransactionHandle,
  ): Promise<Array<{ model: string | null; chunks: number }>>;
}
