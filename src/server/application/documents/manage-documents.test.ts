import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOCUMENT_ID,
  documentFixture,
  ImmediateUnitOfWork,
  InMemoryDocumentRepository,
  InMemoryFileRefRepository,
  InMemoryFileRepository,
  LIBRARY_ID,
} from '../../../../test/helpers/processing-fakes';
import { MAX_DOCUMENT_GROUPS } from '../../../shared/contracts/documents';
import { CollectionRepository } from '../../domain/repositories/collection.repository';
import type { Viewer } from '../../domain/repositories/document.repository';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { DeleteDocument, ListDocumentGroups } from './manage-documents';

const VIEWER: Viewer = { id: '11111111-1111-4111-8111-111111111111', role: 'USER' };

// The shelves of one dimension, in the order and the number they are answered in (docs/07 §7.3).
// The counting itself is the repository's, and is proven against a real database; what is decided
// here is which shelves make it into the answer at all.
describe('ListDocumentGroups', () => {
  let documents: InMemoryDocumentRepository;
  let groups: ListDocumentGroups;

  beforeEach(() => {
    documents = new InMemoryDocumentRepository();
    groups = new ListDocumentGroups(documents);
  });

  it('puts the fullest shelf first, and breaks a tie by the label', async () => {
    documents.groups = [
      { key: 'b', label: 'Bar', count: 2 },
      { key: 'z', label: 'Zabljak', count: 9 },
      { key: 'a', label: 'Ada', count: 2 },
    ];

    const answer = await groups.execute(VIEWER, { by: 'city' });

    // Biggest first, because that is where the archive actually is; the label decides a tie so two
    // runs of the same question answer in the same order.
    expect(answer.items.map((item) => item.label)).toEqual(['Zabljak', 'Ada', 'Bar']);
  });

  it('answers a bounded number of shelves, however many the dimension has', async () => {
    documents.groups = Array.from({ length: MAX_DOCUMENT_GROUPS + 40 }, (_, index) => ({
      key: `person-${index}`,
      label: `Person ${index}`,
      count: index,
    }));

    const answer = await groups.execute(VIEWER, { by: 'person' });

    // A person or a city is an unbounded dimension, and an unbounded aggregate on a request any
    // signed-in caller can repeat is not something to serve (docs/07 §7.1).
    expect(answer.items).toHaveLength(MAX_DOCUMENT_GROUPS);
    // What is cut is the emptiest end of it, never the fullest.
    expect(answer.items[0]?.count).toBe(MAX_DOCUMENT_GROUPS + 39);
  });

  it('hands the repository the filters it was given, and the dimension separately', async () => {
    documents.groups = [];

    await groups.execute(VIEWER, { by: 'person', city: 'Podgorica', processing: false });

    // The dimension is the question, not a filter: counting `by=person` must not narrow anything.
    expect(documents.asked?.by).toBe('person');
    expect(documents.asked?.filters).toEqual({ city: 'Podgorica', processing: false });
    expect(documents.asked?.viewer).toBe(VIEWER);
  });
});

// Only the one method the delete needs: taking a document off every list it is on. A collection is
// somebody else's list, and no foreign key empties it (docs/04 §4.2). Everything else throws rather
// than answering, so a test that starts depending on it says so instead of passing quietly.
function notUsed(): never {
  throw new Error('not part of deleting a document');
}

class RecordingCollectionRepository extends CollectionRepository {
  readonly removedEverywhere: string[] = [];

  removeItemEverywhere(documentId: string): Promise<void> {
    this.removedEverywhere.push(documentId);
    return Promise.resolve();
  }

  listForUser() {
    return notUsed();
  }
  findById() {
    return notUsed();
  }
  isReadableBy() {
    return notUsed();
  }
  findByOwnerAndName() {
    return notUsed();
  }
  create() {
    return notUsed();
  }
  update() {
    return notUsed();
  }
  softDelete() {
    return notUsed();
  }
  addItem() {
    return notUsed();
  }
  removeItem() {
    return notUsed();
  }
  listActiveShares() {
    return notUsed();
  }
  findActiveShare() {
    return notUsed();
  }
  createShare() {
    return notUsed();
  }
  revokeShare() {
    return notUsed();
  }
}

const LIBRARY_FILE = '77777777-7777-4777-8777-777777777777';
const UPLOADED_FILE = '88888888-8888-4888-8888-888888888888';

// 🔒 The one endpoint in Legere that destroys anything (docs/03 §3.3.10, ADR-015 as amended). What
// is asserted here is the shape of the destruction: what goes, what cannot go, and what is left
// behind so that what cannot go does not walk back in.
describe('DeleteDocument', () => {
  let documents: InMemoryDocumentRepository;
  let files: InMemoryFileRepository;
  let fileRefs: InMemoryFileRefRepository;
  let collections: RecordingCollectionRepository;
  let storage: InMemoryFileStorage;
  let remove: DeleteDocument;

  beforeEach(async () => {
    documents = new InMemoryDocumentRepository();
    files = new InMemoryFileRepository();
    fileRefs = new InMemoryFileRefRepository();
    collections = new RecordingCollectionRepository();
    storage = new InMemoryFileStorage();
    remove = new DeleteDocument(
      documents,
      files,
      fileRefs,
      collections,
      storage,
      new ImmediateUnitOfWork(),
    );

    // A document of two files: one on a volume, one uploaded. They are deleted differently, and the
    // difference is the whole point.
    documents.add(documentFixture({ id: DOCUMENT_ID }));
    files.add({ id: LIBRARY_FILE, origin: 'LIBRARY', storageKey: null }, DOCUMENT_ID);
    files.add(
      {
        id: UPLOADED_FILE,
        origin: 'MANAGED',
        ext: 'jpg',
        storageKey: `files/${UPLOADED_FILE}/original.jpg`,
      },
      DOCUMENT_ID,
    );
    // The same bytes seen at two paths: both are excluded, or the copy walks the document back in.
    fileRefs.add({ id: 'ref-1', libraryId: LIBRARY_ID, fileId: LIBRARY_FILE });
    fileRefs.add({ id: 'ref-2', libraryId: LIBRARY_ID, fileId: LIBRARY_FILE });

    await storage.put(`documents/${DOCUMENT_ID}/canonical.pdf`, Buffer.alloc(4), 'application/pdf');
    await storage.put(`documents/${DOCUMENT_ID}/preview.jpg`, Buffer.alloc(4), 'image/jpeg');
    await storage.put(`files/${UPLOADED_FILE}/original.jpg`, Buffer.alloc(4), 'image/jpeg');
    await storage.put('documents/other/preview.jpg', Buffer.alloc(4), 'image/jpeg');
  });

  it('deletes the document, its files and everything of its own in the bucket', async () => {
    await remove.execute(DOCUMENT_ID);

    // The row is gone, not hidden: this is the exception ADR-015 makes.
    expect(await documents.findById(DOCUMENT_ID)).toBeNull();
    expect(await files.findById(LIBRARY_FILE)).toBeNull();
    expect(await files.findById(UPLOADED_FILE)).toBeNull();
    expect(collections.removedEverywhere).toEqual([DOCUMENT_ID]);
    // Its artifacts and the upload's own bytes; nothing belonging to anybody else.
    expect(storage.keys()).toEqual(['documents/other/preview.jpg']);
  });

  it('leaves the volume alone and excludes every path the bytes were seen at', async () => {
    await remove.execute(DOCUMENT_ID);

    // 🔒 Nothing is deleted out there — the mount is read-only (ADR-007) — so the refs are what
    // stops the next scan hashing the file and giving it a fresh document (docs/03 §3.3.9).
    expect(fileRefs.refs.map((ref) => ref.status)).toEqual(['EXCLUDED', 'EXCLUDED']);
    expect(fileRefs.refs.map((ref) => ref.fileId)).toEqual([null, null]);
    // The bytes stay identified: the exclusion is about this content at this path.
    expect(fileRefs.refs.every((ref) => ref.contentHash !== null)).toBe(true);
  });

  it('refuses a document that is not there, and one already soft-deleted', async () => {
    const gone = '99999999-9999-4999-8999-999999999999';
    documents.add(documentFixture({ id: gone, deletedAt: new Date('2026-01-01T00:00:00.000Z') }));

    await expect(remove.execute('44444444-4444-4444-8444-444444444444')).rejects.toThrow(
      'Document not found',
    );
    await expect(remove.execute(gone)).rejects.toThrow('Document not found');
  });

  // The rows are gone by the time the bucket is asked, so a bucket that refuses must not be
  // reported as a failed deletion: what is left is an orphan, and the hourly sweep collects those
  // (docs/09 §9.2).
  it('answers ok when the bucket refuses, leaving the objects to the sweep', async () => {
    const refusing = new InMemoryFileStorage();
    refusing.delete = () => Promise.reject(new Error('bucket unreachable'));
    remove = new DeleteDocument(
      documents,
      files,
      fileRefs,
      collections,
      refusing,
      new ImmediateUnitOfWork(),
    );

    await expect(remove.execute(DOCUMENT_ID)).resolves.toEqual({ ok: true });
    expect(await documents.findById(DOCUMENT_ID)).toBeNull();
  });
});
