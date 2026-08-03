import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  documentFixture,
  FakeDocumentEventRepository,
  ImmediateUnitOfWork,
  InMemoryDocumentRepository,
} from '../../../../test/helpers/processing-fakes';
import { FileTypeMimeDetector } from '../../infrastructure/library/file-type-mime-detector';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { JobQueue } from '../ports/job-queue';
import { artifactKeys } from '../storage/artifact-keys';
import { UploadDocument } from './upload-document';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n');
const VIEWER = { id: 'user-1', role: 'USER' } as const;

// Records what would have been enqueued, and inside which transaction.
class RecordingQueue extends JobQueue {
  readonly enqueued: Array<{ name: string; payload: object }> = [];

  enqueue(name: string, payload: object): Promise<string | null> {
    this.enqueued.push({ name, payload });
    return Promise.resolve('job-1');
  }
  enqueueAfterTx(_tx: unknown, name: string, payload: object): Promise<string | null> {
    return this.enqueue(name, payload);
  }
  scheduleCron(): Promise<void> {
    return Promise.resolve();
  }
  unscheduleCron(): Promise<void> {
    return Promise.resolve();
  }
}

// Uploading from the browser (docs/05 §5.1a).
describe('UploadDocument', () => {
  let documents: InMemoryDocumentRepository;
  let files: InMemoryFileStorage;
  let queue: RecordingQueue;
  let events: FakeDocumentEventRepository;
  let upload: UploadDocument;

  beforeEach(() => {
    documents = new InMemoryDocumentRepository();
    files = new InMemoryFileStorage();
    queue = new RecordingQueue();
    events = new FakeDocumentEventRepository();
    upload = new UploadDocument(
      documents,
      events,
      files,
      new FileTypeMimeDetector(),
      queue,
      new ImmediateUnitOfWork(),
    );
  });

  it('creates an UPLOAD document owned by the uploader and starts the pipeline', async () => {
    const result = await upload.execute(VIEWER, { bytes: PDF, fileName: 'Contract 2026.pdf' });

    expect(result.created).toBe(true);
    expect(result.document).toMatchObject({
      title: 'Contract 2026',
      ext: 'pdf',
      mimeType: 'application/pdf',
      source: 'UPLOAD',
      // Its bytes are ours, so it can never be "missing" the way a library file can.
      availability: 'AVAILABLE',
      processing: true,
    });
    const stored = documents.documents.get(result.document.id);
    expect(stored?.createdById).toBe(VIEWER.id);
    expect(queue.enqueued).toEqual([
      { name: 'document-process', payload: { documentId: result.document.id } },
    ]);
  });

  it('writes the bytes to the bucket under the extension the content actually has', async () => {
    const result = await upload.execute(VIEWER, { bytes: PDF, fileName: 'anything.txt' });

    // Content decides the format, not the name it arrived with (docs/03 §3.3.10).
    expect(result.document.ext).toBe('pdf');
    expect(files.get(artifactKeys.source(result.document.id, 'pdf')).body).toEqual(PDF);
    expect(files.get(artifactKeys.source(result.document.id, 'pdf')).contentType).toBe(
      'application/pdf',
    );
  });

  it('resolves to the document that already holds this content, without processing it again', async () => {
    const first = await upload.execute(VIEWER, { bytes: PDF, fileName: 'a.pdf' });
    documents.readable.set(first.document.id, {
      document: documentFixture({
        id: first.document.id,
        title: 'a',
        source: 'UPLOAD',
        createdById: VIEWER.id,
      }),
      category: null,
      availability: 'AVAILABLE',
      fileRefs: [],
      createdBy: { id: VIEWER.id, displayName: 'the uploader' },
    });
    queue.enqueued.length = 0;

    const again = await upload.execute(VIEWER, { bytes: PDF, fileName: 'a copy.pdf' });

    expect(again.created).toBe(false);
    expect(again.document.id).toBe(first.document.id);
    // 🔒 Known content is never reprocessed — that is what deduplication is for (ADR-009).
    expect(queue.enqueued).toEqual([]);
  });

  it('refuses content that exists in a document the uploader may not read', async () => {
    documents.add(
      documentFixture({
        id: 'someone-elses',
        contentHash: createHash('sha256').update(PDF).digest('hex'),
        source: 'LIBRARY',
        title: 'Confidential',
      }),
    );

    // 🔒 Resolving would hand a stranger a document they were never granted.
    await expect(
      upload.execute(VIEWER, { bytes: PDF, fileName: 'mine.pdf' }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_DUPLICATE', httpStatus: 409 });
    expect(files.keys()).toEqual([]);
  });

  it('refuses an empty file rather than creating a document with nothing in it', async () => {
    await expect(
      upload.execute(VIEWER, { bytes: Buffer.alloc(0), fileName: 'empty.pdf' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('keeps a name with no extension as the whole title, and falls back to bin', async () => {
    const result = await upload.execute(VIEWER, {
      bytes: Buffer.from('just words, no magic bytes'),
      fileName: 'notes',
    });

    expect(result.document.title).toBe('notes');
    expect(files.keys()[0]).toContain('/source.');
  });
});
