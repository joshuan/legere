import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOCUMENT_ID,
  FakeDocumentEventRepository,
  ImmediateUnitOfWork,
  InMemoryDocumentRepository,
  InMemoryFileRefRepository,
  InMemoryFileRepository,
  documentFixture,
  fileFixture,
} from '../../../../test/helpers/processing-fakes';
import { FixedClock } from '../../../../test/helpers/fakes';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import type { Crop } from '../../../shared/contracts/documents';
import type { MimeDetector } from '../ports/mime-detector';
import { updateDocumentFileRequestSchema } from '../../../shared/contracts/files';
import {
  filePageOrderOf,
  filePageRotationsOf,
  pagesForFile,
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
import {
  CombineDocuments,
  ReplaceDocumentFile,
  SplitDocumentFile,
  UpdateDocumentFile,
} from './compose-document';

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
    expect(updateDocumentFileRequestSchema.safeParse({ pageRotations: null }).success).toBe(true);
    // 🔒 And the two this route no longer takes: they are asked of the page that carries them
    // (docs/07 §7.3), so a body naming only one of them names nothing this route understands.
    expect(updateDocumentFileRequestSchema.safeParse({ crop: null }).success).toBe(false);
    expect(updateDocumentFileRequestSchema.safeParse({ rotation: null }).success).toBe(false);
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

  // Which way up the paper lay (docs/03 §3.3.17, docs/07 §7.3): the same shape of edit as the page
  // order beside it, refused on the same terms, and never a change to the bytes. One page's own turn
  // is not here any more — it is asked of the page (`UpdateDocumentPage`), and what a *file* still
  // says is a turn for each of its pages at once.
  describe('which way up its pages lie', () => {
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

    it('takes an order and a list of turns together as one edit and one rebuild', async () => {
      const detail = await given();

      await update.execute(VIEWER, detail, PDF_FILE, {
        pageOrder: [2, 0, 1],
        pageRotations: [0, 3, 0],
      });

      expect((await held()).map((page) => page.pageIndex)).toEqual([2, 0, 1]);
      expect(filePageRotationsOf(await held(), 3)).toEqual([0, 3, 0]);
      expect(queue.enqueued).toHaveLength(1);
    });

    it('refuses a body naming neither of the two, before it reaches the file at all', () => {
      expect(updateDocumentFileRequestSchema.safeParse({}).success).toBe(false);
      expect(updateDocumentFileRequestSchema.safeParse({ pageRotations: null }).success).toBe(true);
      // And the four values a quarter turn may take, and no fifth.
      expect(updateDocumentFileRequestSchema.safeParse({ pageRotations: [4] }).success).toBe(false);
    });
  });

  // 🔒 The point of moving all of this off the file (ADR-025): an edit is about the pages of *this*
  // document, so a file another document also reads is not disturbed by it.
  it('says it about the pages of this document only', async () => {
    const other = 'dddddddd-1111-4111-8111-111111111111';
    documents.add(documentFixture({ id: other, createdById: VIEWER.id }));
    const detail = await given();
    await files.appendPages(other, pagesForFile({ id: PDF_FILE, pageCount: 3 }));

    await update.execute(VIEWER, detail, PDF_FILE, { pageRotations: [0, 1, 0] });

    expect(filePageRotationsOf(await held(), 3)).toEqual([0, 1, 0]);
    const elsewhere = (await pagesOf(other)).filter((page) => page.fileId === PDF_FILE);
    expect(filePageRotationsOf(elsewhere, 3)).toBeNull();
  });
});

// 🔒 The three routes that used `attach`/`detach`/`reorder` — the repository methods that spoke the
// model ADR-025 retired. Each test below fails against the code as it stood: combine handed pages
// over as a fresh reading of their files, a split gave the caller a document made out of somebody
// else's page, and a replacement regrouped the list and trashed a file other documents still read
// (docs/05 §5.6, docs/03 §3.3.16–3.3.17).
describe('Composing across documents, now that a file is no longer one document’s', () => {
  const OTHER = 'dddddddd-2222-4222-8222-222222222222';
  const THIRD = 'dddddddd-3333-4333-8333-333333333333';
  const SCAN = 'ffffffff-2222-4222-8222-222222222222';
  const PHOTO = 'ffffffff-3333-4333-8333-333333333333';
  const CROP: Crop = {
    points: [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.9, 0.9],
      [0.1, 0.9],
    ],
  };

  let documents: InMemoryDocumentRepository;
  let files: InMemoryFileRepository;
  let fileRefs: InMemoryFileRefRepository;
  let events: FakeDocumentEventRepository;
  let queue: RecordingJobQueue;
  let storage: InMemoryFileStorage;
  let clock: FixedClock;

  beforeEach(() => {
    documents = new InMemoryDocumentRepository();
    files = new InMemoryFileRepository();
    fileRefs = new InMemoryFileRefRepository();
    events = new FakeDocumentEventRepository();
    queue = new RecordingJobQueue();
    storage = new InMemoryFileStorage();
    clock = new FixedClock();
  });

  // A detail as the access guard hands it over, read back out of the repository so the pages it
  // carries are the pages that are stored.
  async function detailOf(documentId: string, createdById: string | null): Promise<DocumentDetail> {
    const detail: DocumentDetail = {
      document: documentFixture({ id: documentId, createdById }),
      documentType: null,
      people: [],
      subjects: [],
      files: (await files.listForDocument(documentId)).map(viewOf),
      createdBy: null,
    };
    documents.readable.set(documentId, detail);
    return detail;
  }

  const mime: MimeDetector = {
    detect: (): Promise<{ mime: string; ext: string }> =>
      Promise.resolve({ mime: 'image/jpeg', ext: 'jpg' }),
  };

  const combineOf = (): CombineDocuments =>
    new CombineDocuments(
      documents,
      files,
      events,
      storage,
      queue,
      new ImmediateUnitOfWork(),
      clock,
    );

  const splitOf = (): SplitDocumentFile =>
    new SplitDocumentFile(documents, files, events, queue, new ImmediateUnitOfWork());

  const replaceOf = (): ReplaceDocumentFile =>
    new ReplaceDocumentFile(
      documents,
      files,
      fileRefs,
      events,
      storage,
      mime,
      queue,
      new ImmediateUnitOfWork(),
      clock,
    );

  const rewrite = async (
    documentId: string,
    next: (pages: DocumentPage[]) => DocumentPage[],
  ): Promise<void> => {
    const pages = await files.listPagesForDocument(documentId);
    await files.replacePages(documentId, { expecting: null, pages: next(pages) });
  };

  // 🔒 Defect 3. `attach` rebuilt a file's pages out of its page count, with no turn, no crop and no
  // notion of which pages this document actually held. Combining a document holding a hand-cropped,
  // turned photograph therefore handed the raw picture over — while `03 §3.3.17` says a MANUAL crop
  // is never overwritten by a rebuild.
  it('carries a page’s crop and turn into the document that absorbs it (docs/03 §3.3.17)', async () => {
    documents.add(documentFixture({ id: DOCUMENT_ID, createdById: VIEWER.id }));
    documents.add(documentFixture({ id: OTHER, createdById: VIEWER.id }));
    files.add(fileFixture({ id: SCAN, name: 'target.pdf', pageCount: 1 }), DOCUMENT_ID);
    files.add(fileFixture({ id: PHOTO, name: 'photo.jpg', pageCount: 1 }), OTHER);
    await rewrite(OTHER, (pages) =>
      pages.map((page) => ({
        ...page,
        crop: CROP,
        cropSource: 'MANUAL',
        turn: { quarterTurns: 1, mirrored: false },
      })),
    );

    const target = await detailOf(DOCUMENT_ID, VIEWER.id);
    await detailOf(OTHER, VIEWER.id);
    await combineOf().execute(VIEWER, target, { documentIds: [OTHER] });

    const moved = (await files.listPagesForDocument(DOCUMENT_ID)).find(
      (page) => page.fileId === PHOTO,
    );
    expect(moved?.cropSource).toBe('MANUAL');
    expect(moved?.crop).toEqual(CROP);
    expect(moved?.turn).toEqual({ quarterTurns: 1, mirrored: false });
  });

  it('carries only the pages the absorbed document held, not the whole file again', async () => {
    // A twenty-page scan cut at page eight: this document holds pages 8…19 and nothing before them.
    documents.add(documentFixture({ id: DOCUMENT_ID, createdById: VIEWER.id }));
    documents.add(documentFixture({ id: OTHER, createdById: VIEWER.id }));
    files.add(fileFixture({ id: SCAN, name: 'target.pdf', pageCount: 1 }), DOCUMENT_ID);
    files.add(fileFixture({ id: PHOTO, name: 'twenty.pdf', pageCount: 20 }), OTHER);
    await rewrite(OTHER, (pages) => pages.filter((page) => (page.pageIndex ?? 0) >= 8));

    const target = await detailOf(DOCUMENT_ID, VIEWER.id);
    await detailOf(OTHER, VIEWER.id);
    await combineOf().execute(VIEWER, target, { documentIds: [OTHER] });

    const moved = (await files.listPagesForDocument(DOCUMENT_ID)).filter(
      (page) => page.fileId === PHOTO,
    );
    // Twelve, not twenty: the eight pages somebody cut away stay cut away.
    expect(moved.map((page) => page.pageIndex)).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
  });

  // 🔒 Defect 2. `attach` threw `FILE_ALREADY_IN_DOCUMENT` when any page anywhere already read the
  // file — the invariant ADR-025 retired in so many words — so undoing a split answered 409, though
  // `05 §5.6` calls combine *the* way to move a file between documents.
  it('absorbs a document whose file a third document also reads (ADR-025)', async () => {
    documents.add(documentFixture({ id: DOCUMENT_ID, createdById: VIEWER.id }));
    documents.add(documentFixture({ id: OTHER, createdById: VIEWER.id }));
    documents.add(documentFixture({ id: THIRD, createdById: VIEWER.id }));
    files.add(fileFixture({ id: SCAN, name: 'target.pdf', pageCount: 1 }), DOCUMENT_ID);
    files.add(fileFixture({ id: PHOTO, name: 'shared.pdf', pageCount: 2 }), OTHER);
    // The same file read by pages of a third document, which is what a split leaves behind.
    await files.appendPages(THIRD, pagesForFile({ id: PHOTO, pageCount: 2 }));

    const target = await detailOf(DOCUMENT_ID, VIEWER.id);
    await detailOf(OTHER, VIEWER.id);

    await expect(
      combineOf().execute(VIEWER, target, { documentIds: [OTHER] }),
    ).resolves.toBeDefined();
    // And the third document is untouched: its pages still read the file.
    expect((await files.listPagesForDocument(THIRD)).map((page) => page.pageIndex)).toEqual([0, 1]);
  });

  // 🔒 SEC-47. A split-off file became a document owned by whoever asked rather than by the
  // document's own owner — so any reader of a library document could take somebody else's uploaded
  // page into a private document of their own, which its owner could then no longer read. The two
  // other paths that make a document out of another one take the source's owner (docs/05 §5.6).
  it('gives the split-off document the original’s owner, not the caller’s (SEC-47)', async () => {
    const owner = '99999999-1111-4111-8111-111111111111';
    const reader: Viewer = { id: '88888888-1111-4111-8111-111111111111', role: 'ADMIN' };
    documents.add(documentFixture({ id: DOCUMENT_ID, createdById: owner }));
    files.add(fileFixture({ id: SCAN, name: 'a.pdf', pageCount: 1 }), DOCUMENT_ID);
    files.add(fileFixture({ id: PHOTO, name: 'b.pdf', pageCount: 1 }), DOCUMENT_ID);
    const detail = await detailOf(DOCUMENT_ID, owner);

    const { splitDocumentId } = await splitOf().execute(reader, detail, PHOTO);

    expect((await documents.findById(splitDocumentId))?.createdById).toBe(owner);
  });

  it('takes the pages the document held of that file, with their turns', async () => {
    documents.add(documentFixture({ id: DOCUMENT_ID, createdById: VIEWER.id }));
    files.add(fileFixture({ id: SCAN, name: 'a.pdf', pageCount: 1 }), DOCUMENT_ID);
    files.add(fileFixture({ id: PHOTO, name: 'twenty.pdf', pageCount: 20 }), DOCUMENT_ID);
    // Only the far half is held here, and its last page is turned.
    await rewrite(DOCUMENT_ID, (pages) =>
      pages
        .filter((page) => page.fileId === SCAN || (page.pageIndex ?? 0) >= 18)
        .map((page) =>
          page.fileId === PHOTO && page.pageIndex === 19
            ? { ...page, turn: { quarterTurns: 2, mirrored: false } }
            : page,
        ),
    );
    const detail = await detailOf(DOCUMENT_ID, VIEWER.id);

    const { splitDocumentId } = await splitOf().execute(VIEWER, detail, PHOTO);

    const moved = await files.listPagesForDocument(splitDocumentId);
    expect(moved.map((page) => page.pageIndex)).toEqual([18, 19]);
    expect(moved.at(1)?.turn).toEqual({ quarterTurns: 2, mirrored: false });
  });

  // 🔒 Defect 1, the worst of them. `detach` removed only *this* document's pages and the `trash`
  // call after it was unconditional — no `filterFilesWithoutLivePages`, unlike every other
  // destroying path. Split a scan at page eight and replace the file in one half: the file went to
  // the trash while the other half still held twelve live pages of it. `03 §3.3.16` then said
  // something false, restore answered `FILE_ALREADY_IN_DOCUMENT`, and the retention sweep's
  // `hardDelete` met `document_pages_file_id_fkey ON DELETE RESTRICT` on every run, for ever.
  it('replaces the bytes in every document reading them, and trashes nothing still read', async () => {
    documents.add(documentFixture({ id: DOCUMENT_ID, createdById: VIEWER.id }));
    documents.add(documentFixture({ id: OTHER, createdById: VIEWER.id }));
    files.add(fileFixture({ id: SCAN, name: 'twenty.pdf', pageCount: 20 }), DOCUMENT_ID);
    // The other half of the same scan, exactly as a split at page eight leaves it.
    await files.appendPages(OTHER, pagesForFile({ id: SCAN, pageCount: 20 }));

    const detail = await detailOf(DOCUMENT_ID, VIEWER.id);
    await detailOf(OTHER, VIEWER.id);
    await replaceOf().execute(VIEWER, detail, SCAN, {
      bytes: Buffer.from('a better scan'),
      fileName: 'better.jpg',
    });

    // Both documents read the new bytes; neither is left pointing at a file in the trash.
    expect((await files.listPagesForDocument(DOCUMENT_ID)).some((p) => p.fileId === SCAN)).toBe(
      false,
    );
    expect((await files.listPagesForDocument(OTHER)).some((p) => p.fileId === SCAN)).toBe(false);
    // 🔒 And the old file is in the trash *because* nothing reads it any more — the question every
    // destroying edit asks, rather than an assumption about being the last reader.
    expect((await files.findById(SCAN))?.trashedReason).toBe('REPLACED');
    expect(await files.filterFilesWithoutLivePages([SCAN])).toEqual([SCAN]);
    // Both documents rebuild: a replacement is a change to each of them.
    expect(queue.enqueued.map((job) => job.payload)).toEqual(
      expect.arrayContaining([{ documentId: DOCUMENT_ID }, { documentId: OTHER }]),
    );
  });

  // 🔒 The other half of the same rule: a document the caller may not destroy content in is not
  // quietly rewritten, and the replacement is refused whole (docs/03 §3.4a).
  it('refuses a replacement reaching a document the caller may not destroy content in', async () => {
    const stranger: Viewer = { id: '77777777-1111-4111-8111-111111111111', role: 'USER' };
    documents.add(documentFixture({ id: DOCUMENT_ID, createdById: stranger.id }));
    documents.add(documentFixture({ id: OTHER, createdById: VIEWER.id }));
    // Uploaded rather than on a volume, so this caller may destroy content in their own document —
    // the refusal under test has to be about the *other* one and nothing else.
    files.add(
      fileFixture({ id: SCAN, name: 'shared.pdf', origin: 'MANAGED', pageCount: 2 }),
      DOCUMENT_ID,
    );
    await files.appendPages(OTHER, pagesForFile({ id: SCAN, pageCount: 2 }));

    const detail = await detailOf(DOCUMENT_ID, stranger.id);
    // The other document is somebody else's and is not readable to this caller at all.
    documents.readable.delete(OTHER);

    const replacing = replaceOf().execute(stranger, detail, SCAN, {
      bytes: Buffer.from('a better scan'),
      fileName: 'better.jpg',
    });

    await expect(replacing).rejects.toMatchObject({ code: 'FILE_READ_ELSEWHERE' });
    // Nothing written anywhere: the file is still read by both documents and is not in the trash.
    expect(await files.filterFilesWithoutLivePages([SCAN])).toEqual([]);
    expect((await files.findById(SCAN))?.trashedAt).toBeNull();
  });

  // 🔒 Defect 6. The replacement called `reorder`, which rewrote the list as one block per file, so
  // a photograph inserted between pages two and three of a five-page PDF landed at the end — against
  // `05 §5.6`'s "its pages stand where the old file's pages stood, so the rest of the document does
  // not move".
  it('leaves the new file where the old one’s first page stood (docs/05 §5.6)', async () => {
    documents.add(documentFixture({ id: DOCUMENT_ID, createdById: VIEWER.id }));
    files.add(fileFixture({ id: SCAN, name: 'five.pdf', pageCount: 5 }), DOCUMENT_ID);
    files.add(fileFixture({ id: PHOTO, name: 'photo.jpg', pageCount: 1 }), DOCUMENT_ID);
    // The photograph moved between pages two and three, which is the whole point of ADR-025.
    await rewrite(DOCUMENT_ID, (pages) => {
      const scan = pages.filter((page) => page.fileId === SCAN);
      const photo = pages.filter((page) => page.fileId === PHOTO);
      return [...scan.slice(0, 2), ...photo, ...scan.slice(2)];
    });
    const detail = await detailOf(DOCUMENT_ID, VIEWER.id);

    await replaceOf().execute(VIEWER, detail, PHOTO, {
      bytes: Buffer.from('a better photograph'),
      fileName: 'better.jpg',
    });

    const after = await files.listPagesForDocument(DOCUMENT_ID);
    // Position 2, between pages two and three — not appended after page five.
    expect(after.map((page) => (page.fileId === SCAN ? 'scan' : 'new'))).toEqual([
      'scan',
      'scan',
      'new',
      'scan',
      'scan',
      'scan',
    ]);
    // And it is the new file held whole, uncropped and unturned: different bytes are a different
    // paper, and what the last build counted of one says nothing about the other.
    expect(after.at(2)?.pageIndex).toBeNull();
    expect(after.at(2)?.crop).toBeNull();
  });
});
