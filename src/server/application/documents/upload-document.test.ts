import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeDocumentEventRepository,
  ImmediateUnitOfWork,
  InMemoryDocumentRepository,
  InMemoryFileRepository,
} from '../../../../test/helpers/processing-fakes';
import type { Viewer } from '../../domain/repositories/document.repository';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { JobQueue, type EnqueueOptions, type QueueName } from '../ports/job-queue';
import { MimeDetector, type DetectedType } from '../ports/mime-detector';
import type { TransactionHandle } from '../ports/unit-of-work';
import { UploadDocument } from './upload-document';

// POST /api/documents (docs/05 §5.1a): what happens, and in which order. The order is the point of
// this file — the bytes have to be in the bucket before anything can be enqueued to read them.

const VIEWER: Viewer = { id: '11111111-1111-4111-8111-111111111111', role: 'USER' };
const PDF = Buffer.from('%PDF-1.4\ntrailer\n%%EOF\n');

class StubMimeDetector extends MimeDetector {
  detect(): Promise<DetectedType> {
    return Promise.resolve({ mime: 'application/pdf', ext: 'pdf' });
  }
}

describe('UploadDocument', () => {
  // What happened, in the order it happened: one list, because the question is which came first.
  let log: string[];
  let documents: InMemoryDocumentRepository;
  let files: InMemoryFileRepository;
  let storage: InMemoryFileStorage;
  let upload: UploadDocument;

  class RecordingQueue extends JobQueue {
    readonly enqueued: Array<{ name: QueueName; payload: object }> = [];

    enqueue(name: QueueName, payload: object): Promise<string | null> {
      log.push('enqueue');
      this.enqueued.push({ name, payload });
      return Promise.resolve('job-id');
    }

    enqueueAfterTx(
      _tx: TransactionHandle,
      name: QueueName,
      payload: object,
      _options?: EnqueueOptions,
    ): Promise<string | null> {
      return this.enqueue(name, payload);
    }

    scheduleCron(): Promise<void> {
      return Promise.resolve();
    }

    unscheduleCron(): Promise<void> {
      return Promise.resolve();
    }
  }

  class LoggingStorage extends InMemoryFileStorage {
    override async put(key: string, body: Buffer, contentType: string): Promise<void> {
      log.push('put');
      await super.put(key, body, contentType);
    }
  }

  let queue: RecordingQueue;

  beforeEach(() => {
    log = [];
    documents = new InMemoryDocumentRepository();
    files = new InMemoryFileRepository();
    storage = new LoggingStorage();
    queue = new RecordingQueue();
    upload = new UploadDocument(
      documents,
      files,
      new FakeDocumentEventRepository(),
      storage,
      new StubMimeDetector(),
      queue,
      new ImmediateUnitOfWork(),
    );
  });

  const send = (bytes = PDF, fileName = 'contract.pdf') =>
    upload.execute(VIEWER, { bytes, fileName });

  // 🔒 SEC-90 (docs/09 §9.2). The object used to be written after the commit, under a comment saying
  // the pipeline "cannot outrun this — its first act is to read the rows it was given". It was not
  // true: the job commits with the rows, pg-boss polls every two seconds, and the run's first *read*
  // is the file it was just handed. `getStream` re-throws `NoSuchKey`, no S3 error is a
  // `ServiceUnavailableError`, so the canonical was recorded FAILED with no retry, every reader got
  // `409 CANONICAL_NOT_READY`, and only an admin's reprocess undid it.
  it('writes the bytes before anything can be enqueued to read them', async () => {
    const answer = await send();

    expect(answer.created).toBe(true);
    expect(log).toEqual(['put', 'enqueue']);
  });

  it('writes the object under the key the row records, so the orphan sweep can tell them apart', async () => {
    await send();

    const file = [...files.files.values()][0];
    expect(file).toBeDefined();
    expect(storage.keys()).toEqual([file?.storageKey]);
    // 🔒 The key carries the id the *row* has, not one nobody can look up: the sweep reads the id out
    // of `files/{id}/…` and deletes the object when no file carries it, so a key naming an id the
    // database never issued would be a live original deleted an hour later (docs/09 §9.5).
    expect(file?.storageKey).toBe(`files/${file?.id}/original.pdf`);
  });

  // The dedup check the upload already made stands in front of the write, so the ordinary "these
  // bytes are already here" case costs no object at all; what the sweep pays for is the race the
  // check cannot see — two browsers sending the same bytes at once, and a transaction that rolls
  // back after the object is in the bucket (docs/09 §9.5).
  it('writes nothing when the content is recognised before the transaction opens', async () => {
    await send();
    const afterFirst = storage.keys();

    await expect(send()).rejects.toThrow(/already exists/);

    expect(storage.keys()).toEqual(afterFirst);
  });
});
