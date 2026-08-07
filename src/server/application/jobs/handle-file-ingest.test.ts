import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeDocumentEventRepository,
  ImmediateUnitOfWork,
  InMemoryDocumentRepository,
  InMemoryFileRefRepository,
  InMemoryFileRepository,
  InMemoryLibraryRepository,
  libraryFixture,
  LIBRARY_ID,
  StubLibraryReader,
} from '../../../../test/helpers/processing-fakes';
import { RelativePath } from '../../domain/value-objects/relative-path';
import { MAX_BINARY_BYTES } from '../ports/binary-source';
import { JobQueue, type QueueName } from '../ports/job-queue';
import { MimeDetector, type DetectedType } from '../ports/mime-detector';
import { FileTooLargeError, HandleFileIngest } from './handle-file-ingest';

const REF_ID = '33333333-3333-4333-8333-333333333333';

// Everything the ingest asks of the format detector, without file-type's tables.
class StubMimeDetector extends MimeDetector {
  readonly heads: Uint8Array[] = [];

  detect(head: Uint8Array): Promise<DetectedType> {
    this.heads.push(head);
    return Promise.resolve({ mime: 'application/pdf', ext: 'pdf' });
  }
}

class RecordingQueue extends JobQueue {
  readonly enqueued: { name: QueueName; payload: object }[] = [];

  enqueue(name: QueueName, payload: object): Promise<string | null> {
    this.enqueued.push({ name, payload });
    return Promise.resolve('job-id');
  }
  enqueueAfterTx(_tx: unknown, name: QueueName, payload: object): Promise<string | null> {
    this.enqueued.push({ name, payload });
    return Promise.resolve('job-id');
  }
  scheduleCron(): Promise<void> {
    return Promise.resolve();
  }
  unscheduleCron(): Promise<void> {
    return Promise.resolve();
  }
}

describe('HandleFileIngest', () => {
  let fileRefs: InMemoryFileRefRepository;
  let files: InMemoryFileRepository;
  let documents: InMemoryDocumentRepository;
  let events: FakeDocumentEventRepository;
  let libraries: InMemoryLibraryRepository;
  let reader: StubLibraryReader;
  let mime: StubMimeDetector;
  let queue: RecordingQueue;
  let handler: HandleFileIngest;

  // A ref the scan has seen but not yet hashed, of whatever size it reported.
  function discovered(size: bigint): void {
    fileRefs.add({
      id: REF_ID,
      libraryId: LIBRARY_ID,
      fileId: null,
      path: RelativePath.parse('invoices/a.pdf'),
      size,
      status: 'DISCOVERED',
      contentHash: null,
    });
  }

  beforeEach(() => {
    fileRefs = new InMemoryFileRefRepository();
    files = new InMemoryFileRepository();
    documents = new InMemoryDocumentRepository();
    events = new FakeDocumentEventRepository();
    libraries = new InMemoryLibraryRepository();
    libraries.add(libraryFixture({ rootPath: RelativePath.parse('invoices') }));
    reader = new StubLibraryReader();
    mime = new StubMimeDetector();
    queue = new RecordingQueue();
    handler = new HandleFileIngest(
      fileRefs,
      files,
      documents,
      events,
      libraries,
      reader,
      mime,
      queue,
      new ImmediateUnitOfWork(),
    );
  });

  it('ingests a file of an ordinary size into a document of its own', async () => {
    discovered(11n);
    reader.put('invoices/a.pdf', 'hello world');

    await handler.handle({ fileRefId: REF_ID });

    expect(reader.opened).toEqual(['invoices/a.pdf']);
    expect(fileRefs.refs[0]?.status).toBe('HASHED');
    expect(queue.enqueued.map((job) => job.name)).toEqual(['document-process']);
  });

  // 🔒 SEC-20. Hashing streams, but everything downstream of it reads the file whole into memory,
  // and this process is also the HTTP surface (docs/02 ADR-002). `SCAN_MAX_FILES` bounds how many
  // files a scan takes in, never how large one of them is.
  it('refuses a library file past what one step may hold, without opening it', async () => {
    // The 5 GB PDF of the audit, dropped on a read-only volume by somebody who may not even have an
    // account here — a library volume is not a place this instance controls.
    discovered(5n * 1024n * 1024n * 1024n);
    reader.put('invoices/a.pdf', 'these bytes are never read');

    await expect(handler.handle({ fileRefId: REF_ID })).rejects.toThrow(FileTooLargeError);

    // The refusal costs three queries and no bytes: the size was already recorded by the scan, so
    // nothing had to be read to know it. Without this the file streams in whole, twice.
    expect(reader.opened).toEqual([]);
    expect(fileRefs.refs[0]?.status).toBe('DISCOVERED');
    expect(documents.documents.size).toBe(0);
    expect(queue.enqueued).toEqual([]);
  });

  it('names both the file and the bound, because the operator is the one who has to act', async () => {
    discovered(BigInt(MAX_BINARY_BYTES) + 1n);

    await expect(handler.handle({ fileRefId: REF_ID })).rejects.toThrow(
      new RegExp(`invoices/a\\.pdf is ${MAX_BINARY_BYTES + 1} bytes, past the ${MAX_BINARY_BYTES}`),
    );
  });

  it('accepts a file exactly at the bound, so the guard refuses bombs and not archives', async () => {
    // A cap that fires one byte early would be a cap nobody could reason about; the largest file
    // this instance will process is the largest file it says it will process.
    discovered(BigInt(MAX_BINARY_BYTES));
    reader.put('invoices/a.pdf', 'small enough in practice');

    await handler.handle({ fileRefId: REF_ID });

    expect(reader.opened).toEqual(['invoices/a.pdf']);
  });
});
