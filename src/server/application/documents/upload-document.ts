import { createHash } from 'node:crypto';
import type { UploadDocumentResponse } from '../../../shared/contracts/documents';
import { ConflictError, UnprocessableError } from '../../domain/errors/domain-error';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { DocumentRepository, Viewer } from '../../domain/repositories/document.repository';
import { ContentHash } from '../../domain/value-objects/content-hash';
import { toListDto } from './manage-documents';
import { artifactKeys } from '../storage/artifact-keys';
import type { FileStorage } from '../ports/file-storage';
import type { JobQueue } from '../ports/job-queue';
import type { MimeDetector } from '../ports/mime-detector';
import type { UnitOfWork } from '../ports/unit-of-work';

// Enough bytes for magic-byte detection across the formats file-type recognises — the same head the
// library ingest reads.
const HEAD_BYTES = 4100;

export type UploadInput = {
  // Already materialised: the controller enforces UPLOAD_MAX_BYTES while reading the request, and
  // the pipeline holds whole documents in memory anyway (docs/05 §5.1a).
  bytes: Buffer;
  fileName: string;
};

// POST /api/documents (docs/05 §5.1a, docs/07 §7.3). A document that arrives from a browser rather
// than from a mounted volume: the bytes go to the bucket, the row says UPLOAD, and from the next
// step onwards it is an ordinary document — same pipeline, same viewer, same search.
export class UploadDocument {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly events: DocumentEventRepository,
    private readonly files: FileStorage,
    private readonly mime: MimeDetector,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(viewer: Viewer, input: UploadInput): Promise<UploadDocumentResponse> {
    if (input.bytes.byteLength === 0) {
      throw new UnprocessableError('VALIDATION_FAILED', 'The uploaded file is empty');
    }

    const contentHash = ContentHash.parse(createHash('sha256').update(input.bytes).digest('hex'));
    // Content decides the format, exactly as during ingest: a .pdf that is really a JPEG is a JPEG,
    // and the browser's Content-Type is not evidence (docs/03 §3.3.10).
    const detected = await this.mime.detect(input.bytes.subarray(0, HEAD_BYTES), input.fileName);

    // Deduplication is instance-wide (ADR-009), so the content may already be here. Whether the
    // uploader gets that document or a refusal depends on whether they were allowed to see it —
    // resolving to a document they cannot read would hand out someone else's file.
    const existing = await this.documents.findActiveByContentHash(contentHash.value);
    if (existing !== null) {
      const readable = await this.documents.findReadableById(existing.id, viewer);
      if (readable === null) {
        throw new ConflictError(
          'DOCUMENT_DUPLICATE',
          'This content already exists on this instance, in a document you cannot read',
        );
      }
      return { document: toListDto(readable), created: false };
    }

    const ext = detected.ext === '' ? extensionOf(input.fileName) : detected.ext;

    const created = await this.unitOfWork.run(async (tx) => {
      // findOrCreate rather than create: two browsers sending identical bytes at the same moment
      // converge on one document, the same way two ingests of one file do.
      const { document, wasCreated } = await createDocument(this.documents, tx, {
        contentHash: contentHash.value,
        ext,
        mimeType: detected.mime,
        sizeBytes: BigInt(input.bytes.byteLength),
        title: titleOf(input.fileName),
        createdById: viewer.id,
      });

      if (wasCreated) {
        // The job commits with the row, so a document that exists is always one the pipeline will
        // run (docs/06 §6.3.4).
        await this.queue.enqueueAfterTx(tx, 'document-process', { documentId: document.id });
        await this.events.record(
          {
            documentId: document.id,
            type: 'CREATED',
            actorId: viewer.id,
            payload: { source: 'UPLOAD', path: input.fileName },
          },
          tx,
        );
        await this.events.record(
          { documentId: document.id, type: 'QUEUED', actorId: viewer.id },
          tx,
        );
      }
      return document;
    });

    // After the commit: an object written for a transaction that then rolled back would be an
    // orphan, and maintenance would have to sweep it (docs/09 §9.5). The pipeline is enqueued but
    // cannot outrun this — its first act is to read the row it was given.
    await this.files.put(artifactKeys.source(created.id, ext), input.bytes, detected.mime);

    // Freshly created: nothing is processed yet, no category, no preview — but the grid can show it
    // straight away, marked as processing.
    return {
      document: toListDto({ document: created, category: null, availability: 'AVAILABLE' }),
      created: true,
    };
  }
}

async function createDocument(
  documents: DocumentRepository,
  tx: unknown,
  input: {
    contentHash: string;
    ext: string;
    mimeType: string;
    sizeBytes: bigint;
    title: string;
    createdById: string;
  },
) {
  const { document, created } = await documents.findOrCreateByContentHash(
    { ...input, source: 'UPLOAD' },
    tx,
  );
  return { document, wasCreated: created };
}

// "Contract 2026.pdf" → "Contract 2026"; a name with no extension keeps all of itself.
function titleOf(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function extensionOf(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
