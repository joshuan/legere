import { randomUUID } from 'node:crypto';
import type { UploadDocumentResponse } from '../../../shared/contracts/documents';
import { ConflictError } from '../../domain/errors/domain-error';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { DocumentRepository, Viewer } from '../../domain/repositories/document.repository';
import type { FileRepository } from '../../domain/repositories/file.repository';
import type { FileStorage } from '../ports/file-storage';
import type { JobQueue } from '../ports/job-queue';
import type { MimeDetector } from '../ports/mime-detector';
import type { UnitOfWork } from '../ports/unit-of-work';
import { artifactKeys, servableContentType } from '../storage/artifact-keys';
import { describeUpload, titleOf, type UploadedFile } from './compose-document';
import { listItemOf, toListDto } from './manage-documents';

// POST /api/documents (docs/05 §5.1a, docs/07 §7.3). A document that arrives from a browser rather
// than from a mounted volume: the bytes become a MANAGED file in our own bucket, the file becomes a
// document holding exactly it, and from the next step onwards it is an ordinary document — same
// pipeline, same viewer, same search.
export class UploadDocument {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly files: FileRepository,
    private readonly events: DocumentEventRepository,
    private readonly storage: FileStorage,
    private readonly mime: MimeDetector,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(viewer: Viewer, input: UploadedFile): Promise<UploadDocumentResponse> {
    const upload = await describeUpload(this.mime, input);

    // Deduplication is a property of files now and instance-wide either way (ADR-021), so the
    // content may already be here. Whether the uploader gets the document those bytes live in or a
    // refusal depends on whether they were allowed to see it — resolving to a document they cannot
    // read would hand out somebody else's file (docs/05 §5.1a).
    const known = await this.files.findActiveByContentHash(upload.contentHash);
    if (known !== null) {
      const home = await this.files.findDocumentIdForFile(known.id);
      if (home !== null) {
        const readable = await this.documents.findReadableById(home, viewer);
        if (readable === null) {
          throw new ConflictError(
            'DOCUMENT_DUPLICATE',
            'This content already exists on this instance, in a document you cannot read',
          );
        }
        return { document: toListDto(listItemOf(readable)), created: false };
      }
    }

    // 🔒 The bytes go into the bucket **before** the transaction opens (docs/09 §9.2). They used to
    // go in after it committed, under a comment saying the pipeline "cannot outrun this — its first
    // act is to read the rows it was given", and that was simply false: the job commits with the
    // rows, pg-boss polls every two seconds, and the run's first *read* is the file it was just
    // given. `BuildCanonical.open` asks S3 for the original, `getStream` re-throws `NoSuchKey`
    // unchanged, no S3 error is a `ServiceUnavailableError` — so the canonical is recorded FAILED
    // with no retry (docs/05 §5.4e), the viewer answers `409 CANONICAL_NOT_READY` to every reader,
    // and only an admin's reprocess undoes it. The window is as wide as the upload takes to reach a
    // non-local endpoint, which is exactly the case an operator with remote storage lives in.
    //
    // The cost of this order is the one the sweep exists for: bytes written for a transaction that
    // then rolls back are an orphan under `files/{id}/`, which the hourly maintenance pass collects
    // because no file row carries that id (docs/09 §9.5). A file whose bytes are missing cannot be
    // swept back into existence; a few unreferenced objects can.
    //
    // The id is minted here rather than by the database for the same reason: the key contains it, so
    // writing the object first means knowing it first — and the row must carry the *same* id, or the
    // sweep would read the key, find no file with that id, and delete a live original.
    const fileId = randomUUID();
    const storageKey = artifactKeys.fileOriginal(fileId, upload.ext);
    // 🔒 Stored as what it may be served as, not as what it says it is: the row keeps the detected
    // MIME, and everything that has to understand the file reads the row (docs/09 §9.2).
    await this.storage.put(storageKey, input.bytes, servableContentType(upload.mimeType));

    const stored = await this.unitOfWork.run(async (tx) => {
      const { file, created } = await this.files.findOrCreateByContentHash(
        {
          id: fileId,
          contentHash: upload.contentHash,
          origin: 'MANAGED',
          storageKey,
          mimeType: upload.mimeType,
          ext: upload.ext,
          sizeBytes: BigInt(input.bytes.byteLength),
          name: input.fileName,
        },
        tx,
      );

      const home = await this.files.findDocumentIdForFile(file.id, tx);
      if (home !== null) {
        // Two browsers sent the same bytes at the same moment and the other one won. A file has
        // exactly one home, so this request has nothing left to create (docs/03 §3.3.16).
        throw new ConflictError(
          'DOCUMENT_DUPLICATE',
          'This content already exists on this instance',
        );
      }

      const document = await this.documents.create(
        { title: titleOf(input.fileName), createdById: viewer.id },
        tx,
      );
      await this.files.attach(document.id, file.id, tx);

      // The job commits with the rows, so a document that exists is always one the pipeline will
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
        {
          documentId: document.id,
          type: 'FILE_ATTACHED',
          actorId: viewer.id,
          payload: { source: 'UPLOAD', path: file.name },
        },
        tx,
      );
      await this.events.record({ documentId: document.id, type: 'QUEUED', actorId: viewer.id }, tx);

      return { document, file, created };
    });

    if (!stored.created) {
      // These bytes were already here under another row — deduplication won the race between the
      // check above and the insert. What was just written belongs to nobody, and the sweep that
      // exists for a rolled-back transaction collects it for the same reason (docs/09 §9.5).
      await this.storage.delete(storageKey).catch(() => undefined);
    }

    // Freshly created: nothing is processed yet, no documentType, no preview — but the grid can show
    // it straight away, marked as processing, and one managed file is always readable.
    return {
      document: toListDto({
        document: stored.document,
        documentType: null,
        fileCount: 1,
        primaryExt: stored.file.ext,
        sizeBytes: stored.file.sizeBytes,
        origin: 'MANAGED',
        availability: 'AVAILABLE',
        // Nothing has read it yet, so it is about nobody and nothing (docs/03 §3.3.19–3.3.20).
        people: [],
        subjects: [],
      }),
      created: true,
    };
  }
}
