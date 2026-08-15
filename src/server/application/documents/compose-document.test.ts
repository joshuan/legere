import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOCUMENT_ID,
  FakeDocumentEventRepository,
  ImmediateUnitOfWork,
  InMemoryDocumentRepository,
  InMemoryFileRepository,
  documentFixture,
  fileFixture,
} from '../../../../test/helpers/processing-fakes';
import { updateDocumentFileRequestSchema } from '../../../shared/contracts/files';
import type { File } from '../../domain/entities/file';
import { UnprocessableError } from '../../domain/errors/domain-error';
import type {
  DocumentDetail,
  DocumentFileView,
  Viewer,
} from '../../domain/repositories/document.repository';
import type { EnqueueOptions, QueueName } from '../ports/job-queue';
import { JobQueue } from '../ports/job-queue';
import type { TransactionHandle } from '../ports/unit-of-work';
import { UpdateDocumentFile } from './compose-document';

// PATCH /api/documents/:id/files/:fileId (docs/07 §7.3): what one file says about itself. The crop
// has been here since M13; what is under test is the page order beside it — which is refused unless
// it names exactly the pages the last canonical build counted, and which never touches a byte of the
// file it describes (docs/03 §3.3.16).

const VIEWER: Viewer = { id: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
const PDF_FILE = 'ffffffff-1111-4111-8111-111111111111';

class RecordingJobQueue extends JobQueue {
  readonly enqueued: Array<{ name: QueueName; payload: object }> = [];

  enqueue(name: QueueName, payload: object): Promise<string | null> {
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

function viewOf(file: File, position = 0): DocumentFileView {
  return { ...file, position, available: true, refs: [], earlierVersions: [] };
}

describe('UpdateDocumentFile: the order of the pages inside one file', () => {
  let documents: InMemoryDocumentRepository;
  let files: InMemoryFileRepository;
  let events: FakeDocumentEventRepository;
  let queue: RecordingJobQueue;
  let update: UpdateDocumentFile;

  beforeEach(() => {
    documents = new InMemoryDocumentRepository();
    files = new InMemoryFileRepository();
    events = new FakeDocumentEventRepository();
    queue = new RecordingJobQueue();
    update = new UpdateDocumentFile(documents, files, events, queue, new ImmediateUnitOfWork());
    documents.add(documentFixture({ id: DOCUMENT_ID, createdById: VIEWER.id }));
  });

  // A document of one file, readable and editable by the viewer, with whatever the test needs the
  // file to be: a PDF three pages long unless it says otherwise.
  function given(overrides: Partial<File> = {}): DocumentDetail {
    const file = files.add(
      fileFixture({
        id: PDF_FILE,
        mimeType: 'application/pdf',
        ext: 'pdf',
        name: 'scan.pdf',
        pageCount: 3,
        ...overrides,
      }),
      DOCUMENT_ID,
    );
    const detail: DocumentDetail = {
      document: documentFixture({ id: DOCUMENT_ID, createdById: VIEWER.id }),
      documentType: null,
      people: [],
      subjects: [],
      files: [viewOf(file)],
      createdBy: null,
    };
    documents.readable.set(DOCUMENT_ID, detail);
    return detail;
  }

  const refused = async (detail: DocumentDetail, body: object): Promise<UnprocessableError> => {
    const error = await update
      .execute(VIEWER, detail, PDF_FILE, body)
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    if (!(error instanceof UnprocessableError)) throw new Error(`not refused: ${String(error)}`);
    return error;
  };

  it('stores the permutation and enqueues the rebuild every composition change enqueues', async () => {
    const detail = given();

    await update.execute(VIEWER, detail, PDF_FILE, { pageOrder: [2, 0, 1] });

    expect(files.files.get(PDF_FILE)?.pageOrder).toEqual([2, 0, 1]);
    expect(queue.enqueued).toEqual([
      { name: 'document-process', payload: { documentId: DOCUMENT_ID } },
    ]);
    // The journal reads the pages the way a person counts them, from one (docs/03 §3.3.18).
    expect(events.events.at(0)?.payload).toMatchObject({
      path: 'scan.pdf',
      changes: { pageOrder: { from: null, to: '3, 1, 2' } },
    });
  });

  it('clears the order back to the one the pages arrived in', async () => {
    const detail = given({ pageOrder: [2, 0, 1] });

    await update.execute(VIEWER, detail, PDF_FILE, { pageOrder: null });

    // Nothing to undo: the file was never rewritten, so restoring is a null in one column
    // (docs/03 §3.3.16).
    expect(files.files.get(PDF_FILE)?.pageOrder).toBeNull();
  });

  it('refuses a body naming neither, before it reaches the file at all', () => {
    // The contract is where this one is decided (docs/07 §7.3): "change nothing" is not an edit,
    // and a PATCH that quietly did nothing would look exactly like one that worked.
    expect(updateDocumentFileRequestSchema.safeParse({}).success).toBe(false);
    expect(updateDocumentFileRequestSchema.safeParse({ pageOrder: null }).success).toBe(true);
    expect(updateDocumentFileRequestSchema.safeParse({ crop: null }).success).toBe(true);
  });

  it('refuses an order that is not the whole file, and writes nothing at all', async () => {
    const detail = given({ pageOrder: [2, 0, 1] });

    // Too short, a page named twice, and a page the file does not have: the three ways to get a
    // permutation wrong, all of them `VALIDATION_FAILED` (docs/07 §7.3).
    for (const order of [
      [0, 1],
      [0, 0, 1],
      [0, 1, 3],
      [0, 1, 2, 2],
    ]) {
      expect((await refused(detail, { pageOrder: order })).code).toBe('VALIDATION_FAILED');
    }

    // The order that was there is the order that is there: a refusal changes nothing.
    expect(files.files.get(PDF_FILE)?.pageOrder).toEqual([2, 0, 1]);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('refuses an order for a file whose pages nothing has counted yet', async () => {
    const detail = given({ pageCount: null });

    const error = await refused(detail, { pageOrder: [0, 1, 2] });

    // There is nothing to check the permutation against, and an unchecked one is a canonical built
    // out of pages that do not exist (docs/05 §5.5 step 1.1).
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(files.files.get(PDF_FILE)?.pageOrder).toBeNull();
  });

  it('refuses to order the pages of something that has none', async () => {
    const detail = given({
      mimeType: 'image/jpeg',
      ext: 'jpg',
      name: 'photo.jpg',
      pageCount: null,
    });

    const error = await refused(detail, { pageOrder: [0] });

    expect(error.code).toBe('FILE_NOT_PDF');
  });

  it('still refuses to crop something that is not an image', async () => {
    const detail = given();

    const error = await refused(detail, { crop: null });

    expect(error.code).toBe('FILE_NOT_IMAGE');
  });
});
