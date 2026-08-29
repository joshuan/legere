import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { FileRepository } from '../../domain/repositories/file.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import { isTrashed } from '../../domain/entities/file';
import { ContentHash } from '../../domain/value-objects/content-hash';
import { chunkToBuffer, MAX_BINARY_BYTES } from '../ports/binary-source';
import type { JobQueue } from '../ports/job-queue';
import type { LibraryReader } from '../ports/library-reader';
import type { MimeDetector } from '../ports/mime-detector';
import type { UnitOfWork } from '../ports/unit-of-work';
import { JobHandler } from './job-handler';
import { pagesForFile } from '../../domain/entities/document-page';

export const fileIngestPayloadSchema = z.object({ fileRefId: z.string().uuid() });
export type FileIngestPayload = z.infer<typeof fileIngestPayloadSchema>;

// Enough bytes for magic-byte detection across the formats file-type recognises.
const HEAD_BYTES = 4100;

// Raised when a file on the volume is larger than one step may hold. Named so the failed-job journal
// shows what happened rather than a bare message, and so a test can assert on the kind.
export class FileTooLargeError extends Error {}

// `file-ingest` (docs/05 §5.3). Streams the file once to compute its SHA-256 — the content identity
// that drives deduplication (ADR-009, one level down since ADR-021) — and then asks two questions in
// order: are these bytes already a file, and does that file already have a document? A ref is where
// bytes were seen; the file is the bytes; the document is what a person reads.
//
// Idempotent (docs/05 §5.4): a re-delivered job for a ref that is already HASHED at the same
// size/mtime returns immediately, and hashing the same bytes twice yields the same file either way,
// so even a duplicate that slips through attaches rather than duplicating.
export class HandleFileIngest extends JobHandler {
  constructor(
    private readonly fileRefs: FileRefRepository,
    private readonly files: FileRepository,
    private readonly documents: DocumentRepository,
    private readonly events: DocumentEventRepository,
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
    if (ref.status === 'HASHED' && ref.contentHash !== null && ref.fileId !== null) return;

    const library = await this.libraries.findById(ref.libraryId);
    if (library === null || library.deletedAt !== null) return;

    // 🔒 Refused before a single byte is read, on the size the scan already recorded (docs/03 §3.3.9).
    // Hashing itself streams, but everything downstream of it does not: the canonical build reads
    // this file whole into memory (`toBuffer`), and this process is also the HTTP surface
    // (docs/02 ADR-002), so a 5 GB PDF dropped on a library volume would be ingested happily and
    // then take the instance down one step later. `SCAN_MAX_FILES` bounds how many files a scan
    // takes in, never how large one of them is (docs/05 §5.4).
    //
    // Thrown rather than recorded as a skip, unlike a pipeline step: there is no document to record
    // it against yet — that is the thing this job would have created — and a `FileRef` has no field
    // for a reason. The queue's failed-job journal in the admin panel is where it lands instead,
    // with this message and a manual Retry beside it (docs/05 §5.4, docs/07 admin queue), and the
    // retries cost three queries each because nothing was opened.
    if (ref.size > BigInt(MAX_BINARY_BYTES)) {
      throw new FileTooLargeError(
        `${ref.path.value} is ${ref.size} bytes, past the ${MAX_BINARY_BYTES} bytes one step may ` +
          'hold in memory. Legere leaves it on the volume rather than reading it.',
      );
    }

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
      // Not `String(chunk)`: a chunk that arrives as a plain `Uint8Array` would stringify to the
      // comma-joined decimal spelling of its bytes, and the file's identity — its SHA-256 — would be
      // of that text instead of of the file (see `chunkToBuffer`).
      const buffer = chunkToBuffer(chunk);
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
      // Question one: are these bytes already a file? Known content yields the file that already
      // holds it — the same content on three volumes and in one upload is one file with four homes
      // — and a concurrent ingest of identical bytes still converges on a single row (docs/05 §5.3).
      const { file, created } = await this.files.findOrCreateByContentHash(
        {
          contentHash: contentHash.value,
          // Its bytes stay on the read-only volume; nothing is copied into our bucket (docs/09 §9.2).
          origin: 'LIBRARY',
          storageKey: null,
          mimeType: detected.mime,
          // The detected extension wins over the file name's, since content decides the format;
          // fall back to the name's extension when there are no magic bytes (docs/03 §3.3.16).
          ext: detected.ext === '' ? ref.path.extension : detected.ext,
          sizeBytes: size,
          name: ref.path.name,
        },
        tx,
      );

      // A renamed or copied file takes this same path: it simply becomes another ref to the file
      // that already holds its content (docs/05 §5.3).
      await this.fileRefs.markHashed(ref.id, contentHash.value, file.id, size, ref.mtimeMs, tx);

      // Question two: does that file have a document? A file that was just created cannot have one,
      // which saves the query in the common case.
      const home = created ? null : await this.files.findDocumentIdForFile(file.id, tx);
      if (home !== null) {
        // Nothing else happens. The bytes turned up in one more place, which is a fact about paths
        // and not about documents — and the log is where that is written down (docs/03 §3.3.18).
        await this.events.record(
          {
            documentId: home,
            type: 'FILE_ATTACHED',
            payload: { source: 'LIBRARY', path: ref.path.value },
          },
          tx,
        );
        return;
      }

      // 🔒 A file in the trash has an answer to "where does this belong", and it is not "nowhere"
      // (docs/05 §5.3, §5.7a). Without this, a scan that re-hashed the path — a touched mtime is
      // enough — would hand a thrown-away scan a brand-new document, and the archive would grow the
      // rubbish back faster than anybody could empty it. Restoring one is a person's decision, taken
      // in the trash.
      // Nothing is written down for it: the journal is per document (docs/03 §3.3.18) and there is
      // no document here to write to. The ref is HASHED and points at the file, which is the whole
      // of what this pass has to say.
      if (isTrashed(file)) return;

      // New content: a document holding exactly this file, and the pipeline that builds its
      // canonical PDF (docs/05 §5.3). The job commits with the rows, so a document that exists is
      // always one the pipeline will run (docs/06 §6.3.4). Step statuses default to PENDING in the
      // schema (docs/05 §5.5).
      const document = await this.documents.create({ title: ref.path.stem }, tx);
      await this.files.appendPages(document.id, pagesForFile(file), tx);
      await this.queue.enqueueAfterTx(tx, 'document-process', { documentId: document.id });

      await this.events.record(
        {
          documentId: document.id,
          type: 'CREATED',
          payload: { source: 'LIBRARY', path: ref.path.value },
        },
        tx,
      );
      await this.events.record(
        {
          documentId: document.id,
          type: 'FILE_ATTACHED',
          payload: { source: 'LIBRARY', path: ref.path.value },
        },
        tx,
      );
      await this.events.record({ documentId: document.id, type: 'QUEUED' }, tx);
    });
  }
}
