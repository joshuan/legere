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
import type { Crop } from '../../../shared/contracts/documents';
import { splitDocumentRequestSchema } from '../../../shared/contracts/files';
import type { OrderedPair } from '../../domain/entities/document-link';
import type { DocumentPage } from '../../domain/entities/document-page';
import type { File } from '../../domain/entities/file';
import { DomainError } from '../../domain/errors/domain-error';
import {
  DocumentLinkRepository,
  type DocumentLinkEdge,
} from '../../domain/repositories/document-link.repository';
import type {
  DocumentDetail,
  DocumentFileView,
  Viewer,
} from '../../domain/repositories/document.repository';
import type { DocumentFile } from '../../domain/repositories/file.repository';
import { JobQueue, type EnqueueOptions, type QueueName } from '../ports/job-queue';
import type { TransactionHandle } from '../ports/unit-of-work';
import {
  MoveDocumentPages,
  RemoveDocumentPage,
  ReorderDocumentPages,
  SplitDocumentAtPages,
} from './arrange-pages';

// Arranging a document by the page (docs/05 §5.6, docs/07 §7.3, ADR-025). Every one of these moves
// **entries** and no bytes: the split is one file read by two documents afterwards, and the move is
// an entry changing hands. What the tests watch is therefore the list, the files that are still read
// somewhere, and the rebuild each edit enqueues.

const ADMIN: Viewer = { id: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
const OTHER_USER: Viewer = { id: '22222222-2222-4222-8222-222222222222', role: 'USER' };
const OTHER_DOCUMENT = 'dddddddd-1111-4111-8111-111111111111';
const SCAN = 'ffffffff-1111-4111-8111-111111111111';
const PHOTO = 'ffffffff-2222-4222-8222-222222222222';

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

// The edges between documents (docs/03 §3.3.23), as a set of unordered pairs — which is all a split
// needs of them.
class InMemoryDocumentLinkRepository extends DocumentLinkRepository {
  readonly pairs: OrderedPair[] = [];

  listForDocument(documentId: string): Promise<DocumentLinkEdge[]> {
    return Promise.resolve(
      this.pairs.flatMap((pair) => {
        const other =
          pair.aId === documentId ? pair.bId : pair.bId === documentId ? pair.aId : null;
        return other === null
          ? []
          : [{ otherDocumentId: other, linkedAt: new Date('2026-01-01T12:00:00.000Z') }];
      }),
    );
  }

  exists(pair: OrderedPair): Promise<boolean> {
    return Promise.resolve(this.pairs.some((one) => one.aId === pair.aId && one.bId === pair.bId));
  }

  create(pair: OrderedPair): Promise<void> {
    this.pairs.push(pair);
    return Promise.resolve();
  }

  remove(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function viewOf(file: DocumentFile): DocumentFileView {
  return { ...file, available: true, refs: [], earlierVersions: [] };
}

describe('Arranging a document by the page', () => {
  let documents: InMemoryDocumentRepository;
  let files: InMemoryFileRepository;
  let fileRefs: InMemoryFileRefRepository;
  let links: InMemoryDocumentLinkRepository;
  let events: FakeDocumentEventRepository;
  let queue: RecordingJobQueue;
  let clock: FixedClock;
  let reorder: ReorderDocumentPages;
  let remove: RemoveDocumentPage;
  let split: SplitDocumentAtPages;
  let move: MoveDocumentPages;

  beforeEach(() => {
    documents = new InMemoryDocumentRepository();
    files = new InMemoryFileRepository();
    fileRefs = new InMemoryFileRefRepository();
    links = new InMemoryDocumentLinkRepository();
    events = new FakeDocumentEventRepository();
    queue = new RecordingJobQueue();
    clock = new FixedClock();
    const unitOfWork = new ImmediateUnitOfWork();
    reorder = new ReorderDocumentPages(documents, files, events, queue, unitOfWork);
    remove = new RemoveDocumentPage(documents, files, fileRefs, events, queue, unitOfWork, clock);
    split = new SplitDocumentAtPages(documents, files, links, events, queue, unitOfWork, clock);
    move = new MoveDocumentPages(documents, files, fileRefs, events, queue, unitOfWork, clock);
    documents.add(documentFixture({ id: DOCUMENT_ID, createdById: ADMIN.id }));
  });

  // A document holding the given files, each as many pages as its `pageCount` says.
  async function given(...specs: Array<Partial<File>>): Promise<DocumentDetail> {
    for (const spec of specs) files.add(fileFixture(spec), DOCUMENT_ID);
    return detailOf(DOCUMENT_ID);
  }

  // The detail as the controller would hand it over, read back out of the repository so the pages it
  // carries are the pages that are stored — and left in `readable`, which is what the use cases
  // reload the document through.
  async function detailOf(documentId: string): Promise<DocumentDetail> {
    const document = documents.documents.get(documentId);
    if (document === undefined) throw new Error(`no document ${documentId}`);
    const detail: DocumentDetail = {
      document,
      documentType: null,
      people: [],
      subjects: [],
      files: (await files.listForDocument(documentId)).map(viewOf),
      createdBy: null,
    };
    documents.readable.set(documentId, detail);
    return detail;
  }

  const pagesOf = (documentId = DOCUMENT_ID): Promise<DocumentPage[]> =>
    files.listPagesForDocument(documentId);

  // What the document reads as: one line per page, "file:index", which is the whole of what these
  // use cases move about.
  async function orderOf(documentId = DOCUMENT_ID): Promise<string[]> {
    return (await pagesOf(documentId)).map(
      (page) => `${page.fileId}:${page.pageIndex === null ? 'whole' : page.pageIndex}`,
    );
  }

  const refused = async (act: Promise<unknown>): Promise<DomainError> => {
    const error = await act.then(() => null).catch((thrown: unknown) => thrown);
    if (!(error instanceof DomainError)) throw new Error(`not refused: ${String(error)}`);
    return error;
  };

  const rebuilt = (): string[] =>
    queue.enqueued.flatMap((job) =>
      job.name === 'document-process' && 'documentId' in job.payload
        ? [String(job.payload.documentId)]
        : [],
    );

  describe('the whole order, sent at once', () => {
    it('puts the pages where the client says and enqueues the rebuild', async () => {
      const detail = await given({ id: SCAN, pageCount: 3 });
      const [first, second, third] = await pagesOf();

      await reorder.execute(ADMIN, detail, {
        order: [third?.id ?? '', first?.id ?? '', second?.id ?? ''],
      });

      expect((await pagesOf()).map((page) => page.pageIndex)).toEqual([2, 0, 1]);
      // Positions stay 0-based and contiguous, whatever order the entries arrive in.
      expect((await pagesOf()).map((page) => page.position)).toEqual([0, 1, 2]);
      expect(rebuilt()).toEqual([DOCUMENT_ID]);
      // The journal reads the pages the way a person counts them, from one (docs/03 §3.3.18).
      expect(events.events.at(0)?.payload).toMatchObject({
        changes: { pages: { from: '1, 2, 3', to: '3, 1, 2' } },
      });
    });

    it('moves a page across the boundary between two files', async () => {
      const detail = await given({ id: SCAN, pageCount: 2 }, { id: PHOTO, pageCount: 1 });
      const held = await pagesOf();
      const photo = held.at(2);

      // The photograph between page one and page two of the scan — the whole of what a document
      // being a list of pages buys (ADR-025).
      await reorder.execute(ADMIN, detail, {
        order: [held[0]?.id ?? '', photo?.id ?? '', held[1]?.id ?? ''],
      });

      expect(await orderOf()).toEqual([`${SCAN}:0`, `${PHOTO}:0`, `${SCAN}:1`]);
    });

    it('refuses a partial order, a repeated page and a foreign one, and writes nothing', async () => {
      const detail = await given({ id: SCAN, pageCount: 3 });
      const held = await pagesOf();
      const ids = held.map((page) => page.id);

      for (const order of [
        [ids[0] ?? ''],
        [ids[0] ?? '', ids[0] ?? '', ids[1] ?? ''],
        [ids[0] ?? '', ids[1] ?? '', 'a-page-of-nothing'],
      ]) {
        expect((await refused(reorder.execute(ADMIN, detail, { order }))).code).toBe(
          'VALIDATION_FAILED',
        );
      }

      expect((await pagesOf()).map((page) => page.id)).toEqual(ids);
      expect(rebuilt()).toEqual([]);
    });
  });

  describe('a page removed', () => {
    it('takes the entry out, closes the list up behind it and rebuilds', async () => {
      const detail = await given({ id: SCAN, pageCount: 3 });
      const held = await pagesOf();

      await remove.execute(ADMIN, detail, held[1]?.id ?? '');

      expect(await orderOf()).toEqual([`${SCAN}:0`, `${SCAN}:2`]);
      expect((await pagesOf()).map((page) => page.position)).toEqual([0, 1]);
      expect(rebuilt()).toEqual([DOCUMENT_ID]);
      // 🔒 The bytes are still read by two pages, so nothing goes anywhere near the trash.
      expect(files.files.get(SCAN)?.trashedAt).toBeNull();
    });

    it('sends a file nothing reads any more to the trash, refs and all', async () => {
      const detail = await given({ id: SCAN, pageCount: 2 }, { id: PHOTO, pageCount: 1 });
      fileRefs.add({ id: 'ref-1', libraryId: 'lib-1', fileId: PHOTO });
      const photo = (await pagesOf()).at(2);

      await remove.execute(ADMIN, detail, photo?.id ?? '');

      const trashed = files.files.get(PHOTO);
      expect(trashed?.trashedAt).toEqual(clock.now());
      expect(trashed?.trashedReason).toBe('PAGE_REMOVED');
      // Under the title of the document it left last, which is the only thing that will still say
      // what these bytes were (docs/03 §3.3.16).
      expect(trashed?.trashedFrom).toBe(detail.document.title);
      // 🔒 And the ref is excluded, so the next scan does not ingest the same bytes into a brand-new
      // document (docs/03 §3.3.9).
      expect(fileRefs.refs.at(0)?.status).toBe('EXCLUDED');
    });

    it('leaves a file another document still reads exactly where it is', async () => {
      documents.add(documentFixture({ id: OTHER_DOCUMENT, createdById: ADMIN.id }));
      const detail = await given({ id: PHOTO, pageCount: 1 }, { id: SCAN, pageCount: 1 });
      await files.attach(OTHER_DOCUMENT, PHOTO);
      const photo = (await pagesOf()).at(0);

      await remove.execute(ADMIN, detail, photo?.id ?? '');

      expect(files.files.get(PHOTO)?.trashedAt).toBeNull();
      expect(await orderOf(OTHER_DOCUMENT)).toEqual([`${PHOTO}:0`]);
    });

    it('refuses the only page there is, and a page of another document', async () => {
      const detail = await given({ id: SCAN, pageCount: 1 });
      const only = (await pagesOf()).at(0);

      // 🔒 A document is emptied by deleting it, not by taking its pages away one at a time.
      expect((await refused(remove.execute(ADMIN, detail, only?.id ?? ''))).code).toBe(
        'DOCUMENT_LAST_PAGE',
      );
      expect((await refused(remove.execute(ADMIN, detail, 'not-a-page-of-this'))).code).toBe(
        'PAGE_NOT_FOUND',
      );
      expect(await orderOf()).toEqual([`${SCAN}:0`]);
      expect(rebuilt()).toEqual([]);
    });
  });

  describe('a document cut at a page', () => {
    it('divides the entries between the parts over the same files, and links them', async () => {
      const detail = await given({ id: SCAN, pageCount: 12 });

      const answer = await split.execute(ADMIN, detail, { at: [8] });

      const [madeId] = answer.splitDocumentIds;
      expect(answer.splitDocumentIds).toHaveLength(1);
      expect((await pagesOf()).map((page) => page.pageIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect((await pagesOf(madeId ?? '')).map((page) => page.pageIndex)).toEqual([8, 9, 10, 11]);
      // 🔒 One file, read by pages in two places: no bytes were copied and nothing was extracted,
      // which is what ADR-025 exists to make possible.
      expect(files.files.size).toBe(1);
      expect(files.files.get(SCAN)?.trashedAt).toBeNull();
      // The halves are linked to each other (ADR-023) — separate, and together.
      expect(links.pairs).toHaveLength(1);
      expect(
        (await links.listForDocument(DOCUMENT_ID)).map((edge) => edge.otherDocumentId),
      ).toEqual([madeId]);
      // Both sides rebuild, because both are different documents to read now.
      expect(rebuilt().sort()).toEqual([DOCUMENT_ID, madeId ?? ''].sort());
    });

    it('gives each part the original’s owner and nothing it has not earned', async () => {
      documents.add(
        documentFixture({
          id: DOCUMENT_ID,
          createdById: OTHER_USER.id,
          title: 'Two contracts in one scan',
          typeId: 'a-type',
        }),
      );
      const detail = await given({ id: SCAN, pageCount: 4, name: 'scan.pdf' });

      const answer = await split.execute(ADMIN, detail, { at: [2] });
      const made = documents.documents.get(answer.splitDocumentIds[0] ?? '');

      // The owner and the access travel; the title, the type and the people do not — half a paper is
      // not the paper, and the pipeline reads it afresh (docs/05 §5.6).
      expect(made?.createdById).toBe(OTHER_USER.id);
      expect(made?.title).toBe('scan');
      expect(made?.titleSource).toBe('NONE');
      expect(made?.typeId).toBeNull();
    });

    it('cuts at several boundaries at once and links every part to every other', async () => {
      const detail = await given({ id: SCAN, pageCount: 6 });

      const answer = await split.execute(ADMIN, detail, { at: [4, 2] });

      // The boundaries are read in order however they were sent.
      expect((await pagesOf()).map((page) => page.pageIndex)).toEqual([0, 1]);
      const [second, third] = answer.splitDocumentIds;
      expect((await pagesOf(second ?? '')).map((page) => page.pageIndex)).toEqual([2, 3]);
      expect((await pagesOf(third ?? '')).map((page) => page.pageIndex)).toEqual([4, 5]);
      // Three parts, three edges: from any one of them the other two are one hop away.
      expect(links.pairs).toHaveLength(3);
      expect(rebuilt()).toHaveLength(3);
    });

    it('refuses a cut at the first page, past the last, or named twice', async () => {
      const detail = await given({ id: SCAN, pageCount: 3 });

      // The first is refused by the contract itself: a part with nothing in it is not a document.
      expect(splitDocumentRequestSchema.safeParse({ at: [0] }).success).toBe(false);
      expect(splitDocumentRequestSchema.safeParse({ at: [] }).success).toBe(false);
      expect((await refused(split.execute(ADMIN, detail, { at: [3] }))).code).toBe(
        'VALIDATION_FAILED',
      );
      expect((await refused(split.execute(ADMIN, detail, { at: [1, 1] }))).code).toBe(
        'VALIDATION_FAILED',
      );

      expect((await pagesOf()).map((page) => page.pageIndex)).toEqual([0, 1, 2]);
      expect(documents.documents.size).toBe(1);
      expect(rebuilt()).toEqual([]);
    });
  });

  describe('pages moved to another document', () => {
    beforeEach(() => {
      documents.add(documentFixture({ id: OTHER_DOCUMENT, createdById: ADMIN.id }));
    });

    it('takes the entries out of one list and into the other, at the position asked for', async () => {
      const detail = await given({ id: SCAN, pageCount: 3 });
      files.add(fileFixture({ id: PHOTO, pageCount: 2 }), OTHER_DOCUMENT);
      await detailOf(OTHER_DOCUMENT);
      const moving = (await pagesOf()).at(2);

      const answer = await move.execute(ADMIN, detail, {
        pageIds: [moving?.id ?? ''],
        documentId: OTHER_DOCUMENT,
        at: 1,
      });

      expect(answer.movedToDocumentId).toBe(OTHER_DOCUMENT);
      expect(await orderOf()).toEqual([`${SCAN}:0`, `${SCAN}:1`]);
      expect(await orderOf(OTHER_DOCUMENT)).toEqual([`${PHOTO}:0`, `${SCAN}:2`, `${PHOTO}:1`]);
      // 🔒 The bytes did not move — they were never in a document to begin with — so the file is
      // still exactly where it was, now read from two places.
      expect(files.files.get(SCAN)?.trashedAt).toBeNull();
      expect(rebuilt().sort()).toEqual([DOCUMENT_ID, OTHER_DOCUMENT].sort());
      // Both journals say what happened, each naming the other.
      const payloads = events.events.map((event) => event.payload);
      expect(payloads).toContainEqual(
        expect.objectContaining({ otherDocumentId: OTHER_DOCUMENT, source: 'MOVE' }),
      );
      expect(payloads).toContainEqual(
        expect.objectContaining({ otherDocumentId: DOCUMENT_ID, source: 'MOVE' }),
      );
    });

    it('makes a document to hold them when asked for a new one', async () => {
      documents.add(
        documentFixture({ id: DOCUMENT_ID, createdById: OTHER_USER.id, title: 'A pile of scans' }),
      );
      const detail = await given({ id: SCAN, pageCount: 2 }, { id: PHOTO, name: 'photo.jpg' });
      const photo = (await pagesOf()).at(2);

      const answer = await move.execute(ADMIN, detail, {
        pageIds: [photo?.id ?? ''],
        documentId: null,
      });

      const made = documents.documents.get(answer.movedToDocumentId);
      expect(await orderOf(answer.movedToDocumentId)).toEqual([`${PHOTO}:whole`]);
      // The source's owner, exactly as a split's parts take the original's.
      expect(made?.createdById).toBe(OTHER_USER.id);
      expect(made?.title).toBe('photo');
      expect(await orderOf()).toEqual([`${SCAN}:0`, `${SCAN}:1`]);
    });

    it('keeps what the page said about itself as it changes hands', async () => {
      await given({ id: PHOTO, pageCount: 1 }, { id: SCAN, pageCount: 1 });
      const crop: Crop = {
        points: [
          [0, 0],
          [0.5, 0],
          [0.5, 1],
          [0, 1],
        ],
      };
      await files.replacePages(DOCUMENT_ID, [
        {
          fileId: PHOTO,
          pageIndex: 0,
          turn: { quarterTurns: 1, mirrored: false },
          crop,
          cropSource: 'MANUAL',
        },
        { fileId: SCAN, pageIndex: 0, turn: null, crop: null, cropSource: 'NONE' },
      ]);
      const current = await detailOf(DOCUMENT_ID);
      const photo = (await pagesOf()).at(0);

      const answer = await move.execute(ADMIN, current, {
        pageIds: [photo?.id ?? ''],
        documentId: null,
      });

      // 🔒 A turn and a crop are what this page says about itself, so they travel with the entry —
      // and neither was ever an edit to the file (docs/03 §3.3.17).
      const moved = (await pagesOf(answer.movedToDocumentId)).at(0);
      expect(moved?.turn).toEqual({ quarterTurns: 1, mirrored: false });
      expect(moved?.crop).toEqual(crop);
      expect(moved?.cropSource).toBe('MANUAL');
    });

    it('🔒 refuses a move into a document the caller may not edit, whole', async () => {
      // Two documents of uploaded bytes: one the mover's own, one somebody else's — readable, and
      // not theirs to change (docs/03 §3.4).
      documents.add(documentFixture({ id: DOCUMENT_ID, createdById: OTHER_USER.id }));
      documents.add(documentFixture({ id: OTHER_DOCUMENT, createdById: ADMIN.id }));
      const detail = await given({ id: SCAN, pageCount: 2, origin: 'MANAGED' });
      files.add(fileFixture({ id: PHOTO, origin: 'MANAGED' }), OTHER_DOCUMENT);
      await detailOf(OTHER_DOCUMENT);
      const moving = (await pagesOf()).at(0);

      const error = await refused(
        move.execute(OTHER_USER, detail, {
          pageIds: [moving?.id ?? ''],
          documentId: OTHER_DOCUMENT,
        }),
      );

      expect(error.code).toBe('FORBIDDEN');
      // Refused whole rather than done by halves: neither list moved and nothing was enqueued.
      expect(await orderOf()).toEqual([`${SCAN}:0`, `${SCAN}:1`]);
      expect(await orderOf(OTHER_DOCUMENT)).toEqual([`${PHOTO}:whole`]);
      expect(rebuilt()).toEqual([]);
    });

    it('refuses a target the caller cannot even see', async () => {
      const detail = await given({ id: SCAN, pageCount: 2 });
      const moving = (await pagesOf()).at(0);
      documents.readable.delete(OTHER_DOCUMENT);

      const error = await refused(
        move.execute(ADMIN, detail, {
          pageIds: [moving?.id ?? ''],
          documentId: OTHER_DOCUMENT,
        }),
      );

      expect(error.code).toBe('DOCUMENT_NOT_FOUND');
      expect(rebuilt()).toEqual([]);
    });

    it('refuses a move that would empty the document, a foreign page and a position past the end', async () => {
      const detail = await given({ id: SCAN, pageCount: 2 });
      files.add(fileFixture({ id: PHOTO }), OTHER_DOCUMENT);
      await detailOf(OTHER_DOCUMENT);
      const ids = (await pagesOf()).map((page) => page.id);

      expect(
        (await refused(move.execute(ADMIN, detail, { pageIds: ids, documentId: OTHER_DOCUMENT })))
          .code,
      ).toBe('DOCUMENT_LAST_PAGE');
      expect(
        (
          await refused(
            move.execute(ADMIN, detail, {
              pageIds: ['a-page-of-nothing'],
              documentId: OTHER_DOCUMENT,
            }),
          )
        ).code,
      ).toBe('VALIDATION_FAILED');
      expect(
        (
          await refused(
            move.execute(ADMIN, detail, {
              pageIds: [ids[0] ?? '', ids[0] ?? ''],
              documentId: OTHER_DOCUMENT,
            }),
          )
        ).code,
      ).toBe('VALIDATION_FAILED');
      expect(
        (
          await refused(
            move.execute(ADMIN, detail, {
              pageIds: [ids[0] ?? ''],
              documentId: OTHER_DOCUMENT,
              at: 9,
            }),
          )
        ).code,
      ).toBe('VALIDATION_FAILED');
      expect(
        (
          await refused(
            move.execute(ADMIN, detail, { pageIds: [ids[0] ?? ''], documentId: DOCUMENT_ID }),
          )
        ).code,
      ).toBe('VALIDATION_FAILED');

      expect(await orderOf()).toEqual([`${SCAN}:0`, `${SCAN}:1`]);
      expect(await orderOf(OTHER_DOCUMENT)).toEqual([`${PHOTO}:whole`]);
      expect(rebuilt()).toEqual([]);
    });
  });
});
