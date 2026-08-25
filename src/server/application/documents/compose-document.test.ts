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
import type { Crop } from '../../../shared/contracts/documents';
import {
  fileCropOf,
  fileTurnOf,
  filePageOrderOf,
  filePageRotationsOf,
  type DocumentPage,
} from '../../domain/entities/document-page';
import type { File } from '../../domain/entities/file';
import { UnprocessableError } from '../../domain/errors/domain-error';
import type {
  DocumentDetail,
  DocumentFileView,
  Viewer,
} from '../../domain/repositories/document.repository';
import type { DocumentFile } from '../../domain/repositories/file.repository';
import type { EnqueueOptions, QueueName } from '../ports/job-queue';
import { JobQueue } from '../ports/job-queue';
import type { TransactionHandle } from '../ports/unit-of-work';
import { UpdateDocumentFile } from './compose-document';

// PATCH /api/documents/:id/files/:fileId (docs/07 §7.3): what one file says about the document
// reading it. Since ADR-025 none of it is stored on the file — a crop, a turn and the order of the
// pages are written on the **entries** this document holds (docs/03 §3.3.17) — so what these tests
// watch is the list, and what they still refuse is exactly what they refused before.

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

function viewOf(file: DocumentFile): DocumentFileView {
  return { ...file, available: true, refs: [], earlierVersions: [] };
}

describe('UpdateDocumentFile: what one file says about the document reading it', () => {
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
  // file to be: a PDF three pages long unless it says otherwise. A counted file is held as its own
  // pages; an uncounted one as a single entry standing for it whole (docs/03 §3.3.17).
  async function given(overrides: Partial<File> = {}): Promise<DocumentDetail> {
    files.add(
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
    return reload();
  }

  // The detail as the controller would hand it over, read back out of the repository so that the
  // pages it carries are the pages that are stored.
  async function reload(): Promise<DocumentDetail> {
    const detail: DocumentDetail = {
      document: documentFixture({ id: DOCUMENT_ID, createdById: VIEWER.id }),
      documentType: null,
      people: [],
      subjects: [],
      files: (await files.listForDocument(DOCUMENT_ID)).map(viewOf),
      createdBy: null,
    };
    documents.readable.set(DOCUMENT_ID, detail);
    return detail;
  }

  const pagesOf = async (documentId = DOCUMENT_ID): Promise<DocumentPage[]> =>
    files.listPagesForDocument(documentId);

  const held = async (fileId = PDF_FILE): Promise<DocumentPage[]> =>
    (await pagesOf()).filter((page) => page.fileId === fileId);

  const refused = async (detail: DocumentDetail, body: object): Promise<UnprocessableError> => {
    const error = await update
      .execute(VIEWER, detail, PDF_FILE, body)
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    if (!(error instanceof UnprocessableError)) throw new Error(`not refused: ${String(error)}`);
    return error;
  };

  it('stores the permutation and enqueues the rebuild every composition change enqueues', async () => {
    const detail = await given();

    await update.execute(VIEWER, detail, PDF_FILE, { pageOrder: [2, 0, 1] });

    // The pages of the file now sit in that order in this document, which is where a page order
    // lives since ADR-025.
    expect((await held()).map((page) => page.pageIndex)).toEqual([2, 0, 1]);
    expect(filePageOrderOf(await held(), 3)).toEqual([2, 0, 1]);
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
    const detail = await given();
    await update.execute(VIEWER, detail, PDF_FILE, { pageOrder: [2, 0, 1] });

    await update.execute(VIEWER, await reload(), PDF_FILE, { pageOrder: null });

    // Nothing to undo: the file was never rewritten, so restoring is the entries back in the order
    // the pages arrived in (docs/03 §3.3.17).
    expect((await held()).map((page) => page.pageIndex)).toEqual([0, 1, 2]);
    expect(filePageOrderOf(await held(), 3)).toBeNull();
  });

  it('refuses a body naming neither, before it reaches the file at all', () => {
    // The contract is where this one is decided (docs/07 §7.3): "change nothing" is not an edit,
    // and a PATCH that quietly did nothing would look exactly like one that worked.
    expect(updateDocumentFileRequestSchema.safeParse({}).success).toBe(false);
    expect(updateDocumentFileRequestSchema.safeParse({ pageOrder: null }).success).toBe(true);
    expect(updateDocumentFileRequestSchema.safeParse({ crop: null }).success).toBe(true);
  });

  it('refuses an order that is not the whole file, and writes nothing at all', async () => {
    const detail = await given();
    await update.execute(VIEWER, detail, PDF_FILE, { pageOrder: [2, 0, 1] });
    const current = await reload();
    queue.enqueued.length = 0;

    // Too short, a page named twice, and a page the file does not have: the three ways to get a
    // permutation wrong, all of them `VALIDATION_FAILED` (docs/07 §7.3).
    for (const order of [
      [0, 1],
      [0, 0, 1],
      [0, 1, 3],
      [0, 1, 2, 2],
    ]) {
      expect((await refused(current, { pageOrder: order })).code).toBe('VALIDATION_FAILED');
    }

    // The order that was there is the order that is there: a refusal changes nothing.
    expect((await held()).map((page) => page.pageIndex)).toEqual([2, 0, 1]);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('refuses an order for a file whose pages nothing has counted yet', async () => {
    const detail = await given({ pageCount: null });

    const error = await refused(detail, { pageOrder: [0, 1, 2] });

    // There is nothing to check the permutation against, and an unchecked one is a canonical built
    // out of pages that do not exist (docs/05 §5.5 step 1).
    expect(error.code).toBe('VALIDATION_FAILED');
    expect((await held()).map((page) => page.pageIndex)).toEqual([null]);
  });

  it('refuses to order the pages of something that has none', async () => {
    const detail = await given({
      mimeType: 'image/jpeg',
      ext: 'jpg',
      name: 'photo.jpg',
      pageCount: null,
    });

    const error = await refused(detail, { pageOrder: [0] });

    expect(error.code).toBe('FILE_NOT_PDF');
  });

  it('still refuses to crop something that is not an image', async () => {
    const detail = await given();

    const error = await refused(detail, { crop: null });

    expect(error.code).toBe('FILE_NOT_IMAGE');
  });

  // Which way up the paper lay (docs/03 §3.3.17, docs/07 §7.3): the same shape of edit as the crop
  // and the page order beside it, refused on the same terms, and never a change to the bytes.
  describe('which way up it lies', () => {
    it('stores an image turn and enqueues the same rebuild', async () => {
      const detail = await given({ mimeType: 'image/jpeg', ext: 'jpg', name: 'photo.jpg' });

      await update.execute(VIEWER, detail, PDF_FILE, {
        rotation: { quarterTurns: 1, mirrored: true },
      });

      expect(fileTurnOf(await held())).toEqual({ quarterTurns: 1, mirrored: true });
      expect(queue.enqueued).toEqual([
        { name: 'document-process', payload: { documentId: DOCUMENT_ID } },
      ]);
      // The journal says it in degrees, which is how a person says it out loud.
      expect(events.events.at(0)?.payload).toMatchObject({
        path: 'photo.jpg',
        changes: { rotation: { from: null, to: '90° mirrored' } },
      });
    });

    it('clears an image turn back to the way it arrived', async () => {
      const detail = await given({ mimeType: 'image/jpeg', ext: 'jpg', name: 'photo.jpg' });
      await update.execute(VIEWER, detail, PDF_FILE, {
        rotation: { quarterTurns: 2, mirrored: false },
      });

      await update.execute(VIEWER, await reload(), PDF_FILE, { rotation: null });

      // Nothing to undo: the turn was an instruction beside bytes nobody rewrote (docs/03 §3.3.17).
      expect(fileTurnOf(await held())).toBeNull();
    });

    it('refuses to turn a PDF as if it were one picture', async () => {
      const detail = await given();

      const error = await refused(detail, { rotation: { quarterTurns: 1, mirrored: false } });

      // A PDF's pages are turned one at a time — an image has one turn and a PDF has a list.
      expect(error.code).toBe('FILE_NOT_IMAGE');
      expect(fileTurnOf(await held())).toBeNull();
    });

    it('stores one turn per page of a PDF, and clears them again', async () => {
      const detail = await given();

      await update.execute(VIEWER, detail, PDF_FILE, { pageRotations: [0, 1, 0] });
      expect(filePageRotationsOf(await held(), 3)).toEqual([0, 1, 0]);
      expect(events.events.at(0)?.payload).toMatchObject({
        changes: { pageRotations: { from: null, to: '0°, 90°, 0°' } },
      });

      await update.execute(VIEWER, await reload(), PDF_FILE, { pageRotations: null });
      expect(filePageRotationsOf(await held(), 3)).toBeNull();
    });

    it('refuses a list of turns that is not exactly the pages of that file', async () => {
      const detail = await given();
      await update.execute(VIEWER, detail, PDF_FILE, { pageRotations: [0, 1, 0] });
      const current = await reload();
      queue.enqueued.length = 0;

      for (const pageRotations of [
        [0, 1],
        [0, 1, 0, 0],
      ]) {
        expect((await refused(current, { pageRotations })).code).toBe('VALIDATION_FAILED');
      }

      // A refusal changes nothing: what was there is what is there.
      expect(filePageRotationsOf(await held(), 3)).toEqual([0, 1, 0]);
      expect(queue.enqueued).toHaveLength(0);
    });

    it('refuses turns for a file whose pages nothing has counted yet', async () => {
      const detail = await given({ pageCount: null });

      const error = await refused(detail, { pageRotations: [0, 1, 0] });

      expect(error.code).toBe('VALIDATION_FAILED');
      expect(filePageRotationsOf(await held(), 3)).toBeNull();
    });

    it('refuses to turn the pages of something that has none', async () => {
      const detail = await given({ mimeType: 'image/jpeg', ext: 'jpg', name: 'photo.jpg' });

      expect((await refused(detail, { pageRotations: [0] })).code).toBe('FILE_NOT_PDF');
    });

    it('takes a crop and a turn together as one edit and one rebuild', async () => {
      const detail = await given({ mimeType: 'image/jpeg', ext: 'jpg', name: 'photo.jpg' });

      await update.execute(VIEWER, detail, PDF_FILE, {
        crop: {
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        },
        rotation: { quarterTurns: 3, mirrored: false },
      });

      expect(fileCropOf(await held())).not.toBeNull();
      expect(fileTurnOf(await held())).toEqual({ quarterTurns: 3, mirrored: false });
      expect(queue.enqueued).toHaveLength(1);
    });

    it('refuses a body naming none of the four, before it reaches the file at all', () => {
      expect(updateDocumentFileRequestSchema.safeParse({}).success).toBe(false);
      expect(updateDocumentFileRequestSchema.safeParse({ rotation: null }).success).toBe(true);
      expect(updateDocumentFileRequestSchema.safeParse({ pageRotations: null }).success).toBe(true);
      // And the four values a quarter turn may take, and no fifth.
      expect(updateDocumentFileRequestSchema.safeParse({ pageRotations: [4] }).success).toBe(false);
      expect(
        updateDocumentFileRequestSchema.safeParse({
          rotation: { quarterTurns: 4, mirrored: false },
        }).success,
      ).toBe(false);
    });
  });

  // 🔒 The point of moving all of this off the file (ADR-025): an edit is about the pages of *this*
  // document, so a file another document also reads is not disturbed by it.
  it('says it about the pages of this document only', async () => {
    const other = 'dddddddd-1111-4111-8111-111111111111';
    documents.add(documentFixture({ id: other, createdById: VIEWER.id }));
    const detail = await given({ mimeType: 'image/jpeg', ext: 'jpg', name: 'photo.jpg' });
    await files.attach(other, PDF_FILE);

    const crop: Crop = {
      points: [
        [0, 0],
        [0.5, 0],
        [0.5, 1],
        [0, 1],
      ],
    };
    await update.execute(VIEWER, detail, PDF_FILE, { crop });

    expect(fileCropOf(await held())).toEqual(crop);
    const elsewhere = (await pagesOf(other)).filter((page) => page.fileId === PDF_FILE);
    expect(fileCropOf(elsewhere)).toBeNull();
  });
});
