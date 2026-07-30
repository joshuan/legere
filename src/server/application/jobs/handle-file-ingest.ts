import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import { ContentHash } from '../../domain/value-objects/content-hash';
import type { JobQueue } from '../ports/job-queue';
import type { LibraryReader } from '../ports/library-reader';
import type { MimeDetector } from '../ports/mime-detector';
import type { UnitOfWork } from '../ports/unit-of-work';
import { JobHandler } from './job-handler';

export const fileIngestPayloadSchema = z.object({ fileRefId: z.string().uuid() });
export type FileIngestPayload = z.infer<typeof fileIngestPayloadSchema>;

// Enough bytes for magic-byte detection across the formats file-type recognises.
const HEAD_BYTES = 4100;

// `file-ingest` (docs/05 §5.3). Streams the file once to compute its SHA-256 — the content identity
// that drives deduplication (ADR-009) — then either attaches the ref to the document that already has
// that content or creates a new document and starts the pipeline.
//
// Idempotent (docs/05 §5.4): a re-delivered job for a ref that is already HASHED at the same
// size/mtime returns immediately, and hashing the same bytes twice yields the same document either
// way, so even a duplicate that slips through attaches rather than duplicating.
export class HandleFileIngest extends JobHandler {
  constructor(
    private readonly fileRefs: FileRefRepository,
    private readonly documents: DocumentRepository,
    private readonly libraries: LibraryRepository,
    private readonly reader: LibraryReader,
    private readonly mime: MimeDetector,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {
    super();
  }

  async handle(rawPayload: unknown): Promise<void> {
    const { fileRefId } = fileIngestPayloadSchema.parse(rawPayload);

    const ref = await this.fileRefs.findById(fileRefId);
    // The ref may have been superseded by a later scan, or its library deleted.
    if (ref === null) return;
    if (ref.status === 'HASHED' && ref.contentHash !== null && ref.documentId !== null) return;

    const library = await this.libraries.findById(ref.libraryId);
    if (library === null || library.deletedAt !== null) return;

    const stream = await this.reader.openStream(
      { rootPath: library.rootPath, excludeGlobs: library.excludeGlobs },
      ref.path,
    );

    // One pass over the bytes yields both the hash and the head needed for format detection.
    const hasher = createHash('sha256');
    const headChunks: Buffer[] = [];
    let headLength = 0;
    let size = 0n;

    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      hasher.update(buffer);
      size += BigInt(buffer.byteLength);
      if (headLength < HEAD_BYTES) {
        headChunks.push(buffer.subarray(0, HEAD_BYTES - headLength));
        headLength += Math.min(buffer.byteLength, HEAD_BYTES - headLength);
      }
    }

    const contentHash = ContentHash.parse(hasher.digest('hex'));
    const detected = await this.mime.detect(Buffer.concat(headChunks), ref.path.name);

    await this.unitOfWork.run(async (tx) => {
      // One call expresses the dedup rule: known content yields the existing document, new content
      // creates one, and a concurrent ingest of identical bytes still converges on a single document.
      const { document, created } = await this.documents.findOrCreateByContentHash(
        {
          contentHash: contentHash.value,
          source: 'LIBRARY',
          mimeType: detected.mime,
          // The detected extension wins over the file name's, since content decides the format;
          // fall back to the name's extension when there are no magic bytes (docs/03 §3.3.10).
          ext: detected.ext === '' ? ref.path.extension : detected.ext,
          sizeBytes: size,
          // Initial title is the file name without its extension (docs/03 §3.3.10); editable later.
          title: ref.path.stem,
        },
        tx,
      );

      // A renamed or copied file takes this same path: it simply becomes another ref to the document
      // that already holds its content (docs/05 §5.3).
      await this.fileRefs.markHashed(ref.id, contentHash.value, document.id, size, ref.mtimeMs, tx);

      // Only the ingest that created the document starts the pipeline — known content is never
      // reprocessed, which is the point of deduplication. The job commits with the document, so a
      // document that exists is always one the pipeline will run (docs/06 §6.3.4). Step statuses
      // default to PENDING in the schema (docs/05 §5.5).
      if (created) {
        await this.queue.enqueueAfterTx(tx, 'document-process', { documentId: document.id });
      }
    });
  }
}
