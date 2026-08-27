import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Crop } from '../../src/shared/contracts/documents';
import { ConflictError } from '../../src/server/domain/errors/domain-error';
import {
  DocumentRepository,
  type Viewer,
} from '../../src/server/domain/repositories/document.repository';
import { withFileCrop } from '../../src/server/domain/entities/document-page';
import { FileRepository } from '../../src/server/domain/repositories/file.repository';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { PrismaService } from '../../src/server/infrastructure/persistence/prisma.service';
import { disconnectTestPrisma, truncateAll } from '../helpers/db';

// A file is not a document (docs/02 ADR-021, docs/03 §3.3.16–3.3.17): the bytes have a row of their
// own, a document is an ordered list of them, and everything a list row shows about a document —
// how many files, how heavy, where from, whether it can still be read — is derived from those files
// rather than stored. Exercised against the real database, because that is where the derivation and
// the access rule actually live.
describe('Files and documents (integration)', () => {
  let prisma: PrismaService;
  let files: FileRepository;
  let documents: DocumentRepository;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PersistenceModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    files = moduleRef.get(FileRepository);
    documents = moduleRef.get(DocumentRepository);
    close = () => moduleRef.close();
    await truncateAll();
  });

  afterEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await close();
    await disconnectTestPrisma();
  });

  // --- helpers ------------------------------------------------------------------------------

  let hashCounter = 0;
  const nextHash = (): string => {
    hashCounter += 1;
    return hashCounter.toString(16).padStart(64, '0');
  };

  const createUser = async (email: string, role: 'ADMIN' | 'USER' = 'USER'): Promise<Viewer> => {
    const user = await prisma.user.create({
      data: { email, passwordHash: 'x', displayName: email, role },
    });
    return { id: user.id, role };
  };

  const createLibrary = async (
    name: string,
    visibility: 'ALL_USERS' | 'RESTRICTED' = 'ALL_USERS',
  ): Promise<string> => {
    const library = await prisma.library.create({
      data: { name, rootPath: `/${name}`, visibility },
    });
    return library.id;
  };

  const createFile = async (
    overrides: {
      origin?: 'LIBRARY' | 'MANAGED';
      ext?: string;
      sizeBytes?: bigint;
      name?: string;
    } = {},
  ): Promise<string> => {
    const origin = overrides.origin ?? 'LIBRARY';
    const ext = overrides.ext ?? 'pdf';
    const { file } = await files.findOrCreateByContentHash({
      contentHash: nextHash(),
      origin,
      storageKey: origin === 'MANAGED' ? `files/${nextHash()}/original.${ext}` : null,
      mimeType: 'application/pdf',
      ext,
      sizeBytes: overrides.sizeBytes ?? 100n,
      name: overrides.name ?? `whatever.${ext}`,
    });
    return file.id;
  };

  const addRef = async (
    libraryId: string,
    fileId: string,
    path: string,
    status: 'DISCOVERED' | 'HASHED' | 'MISSING' = 'HASHED',
  ): Promise<void> => {
    await prisma.fileRef.create({
      data: {
        libraryId,
        path,
        size: 100n,
        mtime: new Date(),
        status,
        contentHash: nextHash(),
        fileId,
      },
    });
  };

  // A document holding one library file, visible through `libraryId`.
  const libraryDocument = async (
    libraryId: string,
    title: string,
    path: string,
  ): Promise<{ documentId: string; fileId: string }> => {
    const document = await documents.create({ title });
    const fileId = await createFile();
    await files.attach(document.id, fileId);
    await addRef(libraryId, fileId, path);
    return { documentId: document.id, fileId };
  };

  // --- the file repository -------------------------------------------------------------------

  describe('FileRepository', () => {
    it('makes the same bytes one file however often they arrive (ADR-009 at the file level)', async () => {
      const contentHash = nextHash();
      const input = {
        contentHash,
        origin: 'LIBRARY' as const,
        storageKey: null,
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: 12n,
        name: 'contract.pdf',
      };

      const first = await files.findOrCreateByContentHash(input);
      const second = await files.findOrCreateByContentHash({ ...input, name: 'copy.pdf' });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.file.id).toBe(first.file.id);
      // The second arrival brought no new row, so it did not rename the first.
      expect(second.file.name).toBe('contract.pdf');
      expect(await prisma.file.count()).toBe(1);
    });

    it('lets the hash come round again once the file it belonged to is gone', async () => {
      const contentHash = nextHash();
      const input = {
        contentHash,
        origin: 'MANAGED' as const,
        storageKey: 'files/a/original.pdf',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: 12n,
        name: 'contract.pdf',
      };
      const first = await files.findOrCreateByContentHash(input);
      await files.softDelete(first.file.id, new Date());

      const second = await files.findOrCreateByContentHash(input);

      expect(second.created).toBe(true);
      expect(second.file.id).not.toBe(first.file.id);
    });

    it('appends each file at the end and keeps positions contiguous (docs/03 §3.3.17)', async () => {
      const document = await documents.create({ title: 'Passport' });
      const first = await createFile({ name: 'page-1.jpg' });
      const second = await createFile({ name: 'page-2.jpg' });
      const third = await createFile({ name: 'page-3.jpg' });

      await files.attach(document.id, first);
      await files.attach(document.id, second);
      await files.attach(document.id, third);

      const held = await files.listForDocument(document.id);
      expect(held.map((file) => file.position)).toEqual([0, 1, 2]);
      expect(held.map((file) => file.name)).toEqual(['page-1.jpg', 'page-2.jpg', 'page-3.jpg']);
    });

    it('refuses a file that already has a home (FILE_ALREADY_IN_DOCUMENT)', async () => {
      const one = await documents.create({ title: 'One' });
      const other = await documents.create({ title: 'Other' });
      const fileId = await createFile();
      await files.attach(one.id, fileId);

      const attaching = files.attach(other.id, fileId);

      await expect(attaching).rejects.toBeInstanceOf(ConflictError);
      await expect(attaching).rejects.toMatchObject({ code: 'FILE_ALREADY_IN_DOCUMENT' });
    });

    it('rewrites every position in one pass, which is what makes a reorder possible at all', async () => {
      const document = await documents.create({ title: 'Passport' });
      const ids = [
        await createFile({ name: 'a.jpg' }),
        await createFile({ name: 'b.jpg' }),
        await createFile({ name: 'c.jpg' }),
      ];
      for (const id of ids) await files.attach(document.id, id);

      // Reversed: every row moves, so a shift in place would collide with itself on the primary key.
      await files.reorder(document.id, [...ids].reverse());

      const held = await files.listForDocument(document.id);
      expect(held.map((file) => file.name)).toEqual(['c.jpg', 'b.jpg', 'a.jpg']);
      expect(held.map((file) => file.position)).toEqual([0, 1, 2]);
    });

    it('detaches a file, which leaves it free to become a document of its own', async () => {
      const document = await documents.create({ title: 'Passport' });
      const fileId = await createFile();
      await files.attach(document.id, fileId);

      await files.detach(document.id, fileId);

      expect(await files.findDocumentIdForFile(fileId)).toBeNull();
      const elsewhere = await documents.create({ title: 'Its own' });
      await expect(files.attach(elsewhere.id, fileId)).resolves.toBeUndefined();
    });

    it('remembers the home of a file whose document an admin removed (docs/03 §3.3.10)', async () => {
      const document = await documents.create({ title: 'Deleted' });
      const fileId = await createFile();
      await files.attach(document.id, fileId);

      await documents.softDelete(document.id, new Date());

      // Otherwise the next scan would find the file homeless and ingest it all over again.
      expect(await files.findDocumentIdForFile(fileId)).toBe(document.id);
    });

    it('counts only live refs in libraries that still exist (docs/03 §3.3.10)', async () => {
      const live = await createLibrary('live');
      const removed = await createLibrary('removed');
      const here = await createFile();
      const missing = await createFile();
      const orphan = await createFile();
      const onlyInADeletedLibrary = await createFile();

      await addRef(live, here, 'here.pdf');
      await addRef(live, here, 'copy/here.pdf');
      await addRef(live, missing, 'gone.pdf', 'MISSING');
      await addRef(removed, onlyInADeletedLibrary, 'shelved.pdf');
      await prisma.library.update({ where: { id: removed }, data: { deletedAt: new Date() } });

      const counts = await files.countLiveRefsForFiles([
        here,
        missing,
        orphan,
        onlyInADeletedLibrary,
      ]);

      expect(counts.get(here)).toBe(2);
      expect(counts.get(missing)).toBe(0);
      // Every file asked about is in the answer, so availability never has to guess.
      expect(counts.get(orphan)).toBe(0);
      expect(counts.get(onlyInADeletedLibrary)).toBe(0);
    });

    it('reads the files of many documents in one query, in position order', async () => {
      const first = await documents.create({ title: 'First' });
      const second = await documents.create({ title: 'Second' });
      const a = await createFile({ name: 'a.jpg' });
      const b = await createFile({ name: 'b.jpg' });
      const c = await createFile({ name: 'c.jpg' });
      await files.attach(first.id, a);
      await files.attach(first.id, b);
      await files.attach(second.id, c);

      // A document that holds nothing is still in the answer, so a caller never has to guess.
      const empty = await documents.create({ title: 'Empty' });
      const byDocument = await files.listForDocuments([first.id, second.id, empty.id]);

      expect(byDocument.get(first.id)?.map((file) => file.name)).toEqual(['a.jpg', 'b.jpg']);
      expect(byDocument.get(second.id)?.map((file) => file.name)).toEqual(['c.jpg']);
      expect(byDocument.get(empty.id)).toEqual([]);
    });

    it('stores a crop on the page the file is read as, and clears it back to nothing', async () => {
      const document = await documents.create({ title: 'Photographed' });
      const fileId = await createFile({ ext: 'jpg' });
      await files.attach(document.id, fileId);
      // Clockwise from the top-left, normalized to 0…1 of the page (docs/03 §3.3.17).
      const crop: Crop = {
        points: [
          [0.1, 0.1],
          [0.9, 0.12],
          [0.88, 0.95],
          [0.12, 0.9],
        ],
      };

      const held = await files.listPagesForDocument(document.id);
      await files.replacePages(document.id, withFileCrop(held, fileId, crop, 'MANUAL'));

      const cropped = await files.listPagesForDocument(document.id);
      expect(cropped[0]?.crop?.points[2]).toEqual([0.88, 0.95]);
      expect(cropped[0]?.cropSource).toBe('MANUAL');
      // 🔒 And nothing of it is on the file: a crop is a statement about a page (ADR-025).
      expect(cropped[0]?.file.pageCount).toBeNull();

      await files.replacePages(document.id, withFileCrop(cropped, fileId, null, 'NONE'));
      const cleared = await files.listPagesForDocument(document.id);
      expect(cleared[0]?.crop).toBeNull();
      expect(cleared[0]?.cropSource).toBe('NONE');
    });

    it('holds a file every document reading it names, and only trashes what nothing reads', async () => {
      // 🔒 The invariant ADR-025 retired: a file may be read by pages of two documents at once, and
      // the trash is for the file no live page names any more (docs/05 §5.7a).
      const first = await documents.create({ title: 'One half' });
      const second = await documents.create({ title: 'The other' });
      const fileId = await createFile({ ext: 'jpg' });
      await files.attach(first.id, fileId);
      await files.replacePages(second.id, [
        { fileId, pageIndex: null, turn: null, crop: null, cropSource: 'NONE' },
      ]);

      expect(await files.filterFilesWithoutLivePages([fileId])).toEqual([]);

      await files.replacePages(first.id, []);
      expect(await files.filterFilesWithoutLivePages([fileId])).toEqual([]);

      await files.replacePages(second.id, []);
      expect(await files.filterFilesWithoutLivePages([fileId])).toEqual([fileId]);
    });
  });

  // --- what a document is made of ------------------------------------------------------------

  describe('DocumentRepository — derived from the files', () => {
    let admin: Viewer;
    let libraryId: string;

    beforeEach(async () => {
      admin = await createUser('admin@legere.local', 'ADMIN');
      libraryId = await createLibrary('shelf');
    });

    it('counts, weighs and badges a row from the files it holds (docs/07 §7.3)', async () => {
      const document = await documents.create({ title: 'Passport' });
      await files.attach(document.id, await createFile({ ext: 'jpg', sizeBytes: 300n }));
      await files.attach(document.id, await createFile({ ext: 'png', sizeBytes: 40n }));

      const page = await documents.listReadable(admin, { limit: 10 });

      expect(page.items).toHaveLength(1);
      const [item] = page.items;
      expect(item?.fileCount).toBe(2);
      // The first file's extension, which is what the card puts on its badge.
      expect(item?.primaryExt).toBe('jpg');
      expect(item?.sizeBytes).toBe(340n);
    });

    it('is a library document as soon as one of its files sits on a volume', async () => {
      const mixed = await documents.create({ title: 'Absorbed an upload' });
      await files.attach(mixed.id, await createFile({ origin: 'MANAGED' }));
      const onAVolume = await createFile({ origin: 'LIBRARY' });
      await files.attach(mixed.id, onAVolume);
      await addRef(libraryId, onAVolume, 'mixed.pdf');

      const uploaded = await documents.create({ title: 'Uploaded' });
      await files.attach(uploaded.id, await createFile({ origin: 'MANAGED' }));

      const page = await documents.listReadable(admin, { limit: 10 });
      const byTitle = new Map(page.items.map((item) => [item.document.title, item]));

      expect(byTitle.get('Absorbed an upload')?.origin).toBe('LIBRARY');
      expect(byTitle.get('Uploaded')?.origin).toBe('MANAGED');
    });

    it('answers PARTIAL when some of the originals are gone and some are not', async () => {
      const document = await documents.create({ title: 'Half a passport' });
      const here = await createFile();
      const gone = await createFile();
      await files.attach(document.id, here);
      await files.attach(document.id, gone);
      await addRef(libraryId, here, 'here.jpg');
      await addRef(libraryId, gone, 'gone.jpg', 'MISSING');

      const [item] = (await documents.listReadable(admin, { limit: 10 })).items;

      expect(item?.availability).toBe('PARTIAL');
    });

    it('filters on availability with the same rule it derives it from', async () => {
      const available = await documents.create({ title: 'Available' });
      const availableFile = await createFile();
      await files.attach(available.id, availableFile);
      await addRef(libraryId, availableFile, 'available.pdf');

      const partial = await documents.create({ title: 'Partial' });
      const partialHere = await createFile();
      const partialGone = await createFile();
      await files.attach(partial.id, partialHere);
      await files.attach(partial.id, partialGone);
      await addRef(libraryId, partialHere, 'partial-here.pdf');
      await addRef(libraryId, partialGone, 'partial-gone.pdf', 'MISSING');

      const unavailable = await documents.create({ title: 'Unavailable' });
      const unavailableFile = await createFile();
      await files.attach(unavailable.id, unavailableFile);
      await addRef(libraryId, unavailableFile, 'unavailable.pdf', 'MISSING');

      const titles = async (availability: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE') =>
        (await documents.listReadable(admin, { limit: 10, availability })).items.map(
          (item) => item.document.title,
        );

      expect(await titles('AVAILABLE')).toEqual(['Available']);
      expect(await titles('PARTIAL')).toEqual(['Partial']);
      expect(await titles('UNAVAILABLE')).toEqual(['Unavailable']);
    });

    it('filters on origin and on the library the files lie in', async () => {
      const other = await createLibrary('other shelf');
      await libraryDocument(libraryId, 'On the shelf', 'shelf.pdf');
      await libraryDocument(other, 'On the other shelf', 'other.pdf');
      const uploaded = await documents.create({ title: 'Uploaded' });
      await files.attach(uploaded.id, await createFile({ origin: 'MANAGED' }));

      const managed = await documents.listReadable(admin, { limit: 10, origin: 'MANAGED' });
      const library = await documents.listReadable(admin, { limit: 10, origin: 'LIBRARY' });
      const inShelf = await documents.listReadable(admin, { limit: 10, libraryId });

      expect(managed.items.map((item) => item.document.title)).toEqual(['Uploaded']);
      expect(library.items.map((item) => item.document.title).sort()).toEqual([
        'On the other shelf',
        'On the shelf',
      ]);
      expect(inShelf.items.map((item) => item.document.title)).toEqual(['On the shelf']);
    });

    it('lists the files of one document with their places, availability and visible refs', async () => {
      const document = await documents.create({ title: 'Passport' });
      const here = await createFile({ name: 'page-1.jpg', ext: 'jpg' });
      const gone = await createFile({ name: 'page-2.jpg', ext: 'jpg' });
      await files.attach(document.id, here);
      await files.attach(document.id, gone);
      await addRef(libraryId, here, 'passport/page-1.jpg');
      await addRef(libraryId, gone, 'passport/page-2.jpg', 'MISSING');

      const detail = await documents.findReadableById(document.id, admin);

      expect(detail?.files.map((file) => [file.position, file.name, file.available])).toEqual([
        [0, 'page-1.jpg', true],
        [1, 'page-2.jpg', false],
      ]);
      expect(detail?.files[0]?.refs).toEqual([
        expect.objectContaining({ libraryId, path: 'passport/page-1.jpg', status: 'HASHED' }),
      ]);
    });

    // What a card may show besides its title (docs/07 §7.3, docs/11 §11.3): read for a whole page
    // at once, like the files it is derived from.
    it('carries the names a page is about, read for the whole page rather than per row', async () => {
      const lease = await documents.create({ title: 'Lease' });
      const service = await documents.create({ title: 'Service book' });
      await files.attach(lease.id, await createFile());
      await files.attach(service.id, await createFile());
      const [ana, marko] = await Promise.all([
        prisma.person.create({ data: { name: 'Ana Petrović' } }),
        prisma.person.create({ data: { name: 'Marko Marković' } }),
      ]);
      const kind = await prisma.subjectKind.create({ data: { name: 'apartment' } });
      const flat = await prisma.subject.create({ data: { kindId: kind.id, name: 'Njegoševa 5' } });
      await prisma.documentPerson.createMany({
        data: [
          { documentId: lease.id, personId: ana.id },
          { documentId: lease.id, personId: marko.id },
          { documentId: service.id, personId: marko.id },
        ],
      });
      await prisma.documentSubject.create({
        data: { documentId: lease.id, subjectId: flat.id },
      });

      // One `document_id IN (…)` per link table for the whole page, which is what makes carrying
      // the names on every card affordable; the shape of the read is the guarantee (docs/04 §4.4).
      const page = await documents.listReadable(admin, { limit: 10, sort: 'createdAt' });

      const byTitle = new Map(page.items.map((item) => [item.document.title, item]));
      // In catalogue order, and each document with its own names rather than the page's.
      expect(byTitle.get('Lease')?.people.map((person) => person.name)).toEqual([
        'Ana Petrović',
        'Marko Marković',
      ]);
      expect(byTitle.get('Service book')?.people.map((person) => person.name)).toEqual([
        'Marko Marković',
      ]);
      expect(byTitle.get('Lease')?.subjects.map((subject) => subject.name)).toEqual([
        'Njegoševa 5',
      ]);
      expect(byTitle.get('Service book')?.subjects).toEqual([]);
    });

    it('hides the refs of a library the caller cannot see (docs/07 §7.3)', async () => {
      const secret = await createLibrary('secret', 'RESTRICTED');
      const open = await createLibrary('open', 'ALL_USERS');
      const reader = await createUser('reader@legere.local');
      const document = await documents.create({ title: 'In two places' });
      const fileId = await createFile();
      await files.attach(document.id, fileId);
      await addRef(open, fileId, 'open/copy.pdf');
      await addRef(secret, fileId, 'secret/copy.pdf');

      const asReader = await documents.findReadableById(document.id, reader);
      const asAdmin = await documents.findReadableById(document.id, admin);

      expect(asReader?.files[0]?.refs.map((ref) => ref.path)).toEqual(['open/copy.pdf']);
      expect(asAdmin?.files[0]?.refs.map((ref) => ref.path)).toEqual([
        'open/copy.pdf',
        'secret/copy.pdf',
      ]);
      // 🔒 A ref this caller cannot see is still a ref: the file reads either way.
      expect(asReader?.files[0]?.available).toBe(true);
    });
  });

  // --- 🔒 the access rule, in both dialects ---------------------------------------------------

  describe('access (docs/03 §3.4)', () => {
    it('agrees between the query builder and the raw SQL search', async () => {
      const owner = await createUser('owner@legere.local');
      const stranger = await createUser('stranger@legere.local');
      const restricted = await createLibrary('restricted', 'RESTRICTED');
      const open = await createLibrary('open', 'ALL_USERS');

      // Readable to everyone: a file in a library anybody may see.
      await libraryDocument(open, 'invoice on the open shelf', 'open/invoice.pdf');
      // Readable to nobody but an admin: a restricted library, nobody granted.
      await libraryDocument(restricted, 'invoice locked away', 'locked/invoice.pdf');
      // Readable to its creator: an upload nobody shared.
      const uploaded = await documents.create({ title: 'invoice uploaded', createdById: owner.id });
      await files.attach(uploaded.id, await createFile({ origin: 'MANAGED' }));
      // Readable through a collection the stranger was given. 🔒 Created by the collection's owner:
      // a share carries the documents its owner made and nothing else (docs/03 §3.3.15), so a
      // document nobody created is not something a collection can pass on.
      const shared = await documents.create({ title: 'invoice shared', createdById: owner.id });
      await files.attach(shared.id, await createFile({ origin: 'MANAGED' }));
      const collection = await prisma.collection.create({
        data: { ownerId: owner.id, name: 'Shared' },
      });
      await prisma.collectionItem.create({
        data: { collectionId: collection.id, documentId: shared.id, addedById: owner.id },
      });
      await prisma.collectionShare.create({
        data: { collectionId: collection.id, granteeUserId: stranger.id },
      });

      // The title feeds the FTS vector, so the same documents are reachable by search.
      const listed = async (viewer: Viewer): Promise<string[]> =>
        (await documents.listReadable(viewer, { limit: 20 })).items
          .map((item) => item.document.title)
          .sort();
      const searched = async (viewer: Viewer): Promise<string[]> =>
        (await documents.searchByText(viewer, 'invoice', {}, 20))
          .map((match) => match.item.document.title)
          .sort();

      expect(await listed(owner)).toEqual([
        'invoice on the open shelf',
        'invoice shared',
        'invoice uploaded',
      ]);
      expect(await searched(owner)).toEqual(await listed(owner));

      expect(await listed(stranger)).toEqual(['invoice on the open shelf', 'invoice shared']);
      expect(await searched(stranger)).toEqual(await listed(stranger));

      const admin = await createUser('admin2@legere.local', 'ADMIN');
      expect(await listed(admin)).toHaveLength(4);
      expect(await searched(admin)).toEqual(await listed(admin));
    });

    it('opens a restricted library to the users it was granted to', async () => {
      const granted = await createUser('granted@legere.local');
      const other = await createUser('other@legere.local');
      const restricted = await createLibrary('restricted', 'RESTRICTED');
      await prisma.libraryAccess.create({
        data: { libraryId: restricted, userId: granted.id },
      });
      await libraryDocument(restricted, 'Granted', 'granted.pdf');

      expect((await documents.listReadable(granted, { limit: 10 })).items).toHaveLength(1);
      expect((await documents.listReadable(other, { limit: 10 })).items).toHaveLength(0);
    });

    it('keeps a document whose volume vanished visible to whoever could read it', async () => {
      const reader = await createUser('reader2@legere.local');
      const library = await createLibrary('shelf');
      const document = await documents.create({ title: 'Unplugged' });
      const fileId = await createFile();
      await files.attach(document.id, fileId);
      await addRef(library, fileId, 'unplugged.pdf', 'MISSING');

      const page = await documents.listReadable(reader, { limit: 10 });

      // Unavailable, not invisible: the canonical PDF outlives the volume (docs/03 §3.3.10).
      expect(page.items.map((item) => item.availability)).toEqual(['UNAVAILABLE']);
    });

    it('counts a year only where the viewer has a document in it', async () => {
      const reader = await createUser('reader3@legere.local');
      const restricted = await createLibrary('restricted', 'RESTRICTED');
      const open = await createLibrary('open', 'ALL_USERS');
      const mine = await libraryDocument(open, 'Mine', 'mine.pdf');
      const hidden = await libraryDocument(restricted, 'Hidden', 'hidden.pdf');
      await prisma.document.update({
        where: { id: mine.documentId },
        data: { documentDate: new Date('2019-04-01T00:00:00Z') },
      });
      await prisma.document.update({
        where: { id: hidden.documentId },
        data: { documentDate: new Date('2021-04-01T00:00:00Z') },
      });

      expect(await documents.listYears(reader)).toEqual([{ year: 2019, count: 1 }]);
    });

    it('counts a shelf only over the documents the viewer may read', async () => {
      const reader = await createUser('reader4@legere.local');
      const restricted = await createLibrary('restricted', 'RESTRICTED');
      const open = await createLibrary('open', 'ALL_USERS');
      const mine = await libraryDocument(open, 'Mine', 'mine.pdf');
      const hidden = await libraryDocument(restricted, 'Hidden', 'hidden.pdf');
      const person = await prisma.person.create({ data: { name: 'Ana Petrović' } });
      await prisma.documentPerson.createMany({
        data: [
          { documentId: mine.documentId, personId: person.id },
          { documentId: hidden.documentId, personId: person.id },
        ],
      });

      // 🔒 The same rule as every list: a count is a statement about the archive, and one made over
      // documents this reader may not open would be a leak dressed as a number (docs/03 §3.4).
      expect(await documents.countByGroup(reader, 'person', {})).toEqual([
        { key: person.id, label: 'Ana Petrović', count: 1 },
      ]);
      const asAdmin = await createUser('groupadmin@legere.local', 'ADMIN');
      expect(await documents.countByGroup(asAdmin, 'person', {})).toEqual([
        { key: person.id, label: 'Ana Petrović', count: 2 },
      ]);
    });
  });

  // --- the shelves of a dimension (docs/07 §7.3) -----------------------------------------------

  describe('counting the shelves of a dimension', () => {
    let admin: Viewer;

    beforeEach(async () => {
      admin = await createUser('shelfadmin@legere.local', 'ADMIN');
    });

    const documentAbout = async (
      title: string,
      about: { people?: string[]; subjects?: string[]; date?: string; city?: string },
    ): Promise<string> => {
      const document = await documents.create({ title });
      await files.attach(document.id, await createFile({ origin: 'MANAGED' }));
      await prisma.document.update({
        where: { id: document.id },
        data: {
          ...(about.date === undefined
            ? {}
            : { documentDate: new Date(`${about.date}T00:00:00Z`) }),
          ...(about.city === undefined ? {} : { city: about.city }),
        },
      });
      await prisma.documentPerson.createMany({
        data: (about.people ?? []).map((personId) => ({ documentId: document.id, personId })),
      });
      await prisma.documentSubject.createMany({
        data: (about.subjects ?? []).map((subjectId) => ({
          documentId: document.id,
          subjectId,
        })),
      });
      return document.id;
    };

    it('puts a document that belongs to two shelves on both of them', async () => {
      const ana = await prisma.person.create({ data: { name: 'Ana Petrović' } });
      const marko = await prisma.person.create({ data: { name: 'Marko Marković' } });
      await documentAbout('Lease', { people: [ana.id, marko.id] });
      await documentAbout('Service book', { people: [marko.id] });

      const shelves = await documents.countByGroup(admin, 'person', {});

      // Counted on each, because the alternative is a card missing from a shelf it belongs on.
      expect(new Map(shelves.map((shelf) => [shelf.label, shelf.count]))).toEqual(
        new Map([
          ['Ana Petrović', 1],
          ['Marko Marković', 2],
        ]),
      );
      // And the key is what the shelf's own filter takes, so its contents are reachable.
      const key = shelves.find((shelf) => shelf.label === 'Ana Petrović')?.key;
      expect(key).toBe(ana.id);
      const contents = await documents.listReadable(admin, {
        limit: 10,
        ...(key === null || key === undefined ? {} : { personId: key }),
      });
      expect(contents.items.map((item) => item.document.title)).toEqual(['Lease']);
    });

    it('counts the archive under the filters in force, not the whole of it', async () => {
      const kind = await prisma.subjectKind.create({ data: { name: 'apartment' } });
      const flat = await prisma.subject.create({ data: { kindId: kind.id, name: 'Njegoševa 5' } });
      const ana = await prisma.person.create({ data: { name: 'Ana Petrović' } });
      await documentAbout('Lease', { people: [ana.id], subjects: [flat.id] });
      await documentAbout('Letter', { people: [ana.id] });

      expect(await documents.countByGroup(admin, 'person', {})).toEqual([
        { key: ana.id, label: 'Ana Petrović', count: 2 },
      ]);
      // The same shelf, seen through a filter: one of the two is about that flat.
      expect(await documents.countByGroup(admin, 'person', { subjectId: flat.id })).toEqual([
        { key: ana.id, label: 'Ana Petrović', count: 1 },
      ]);
    });

    it('groups by the year on the paper and by the place the document names', async () => {
      await documentAbout('Older', { date: '2019-03-01', city: 'Podgorica' });
      await documentAbout('Same year', { date: '2019-11-02', city: 'Podgorica' });
      await documentAbout('Newer', { date: '2024-05-05', city: 'Bar' });
      // No date and no place read off it. Not on a shelf of either dimension — it belongs to the
      // group of everything the dimension cannot place, which is what `key: null` is: without it a
      // grouped grid would leave this document silently absent rather than filtered out
      // (docs/11 §11.3).
      await documentAbout('Unread', {});

      const years = await documents.countByGroup(admin, 'year', {});
      const cities = await documents.countByGroup(admin, 'city', {});

      expect(new Map(years.map((shelf) => [shelf.key, shelf.count]))).toEqual(
        new Map([
          ['2019', 2],
          ['2024', 1],
          [null, 1],
        ]),
      );
      expect(new Map(cities.map((shelf) => [shelf.key, shelf.count]))).toEqual(
        new Map([
          ['Podgorica', 2],
          ['Bar', 1],
          [null, 1],
        ]),
      );
    });

    it('finds the documents a dimension cannot place, which is what that group links to', async () => {
      await documentAbout('Dated', { date: '2019-03-01' });
      await documentAbout('Undated', {});

      const found = await documents.listReadable(admin, { limit: 10, unassigned: 'year' });

      expect(found.items.map((item) => item.document.title)).toEqual(['Undated']);
    });
  });

  // --- browsing by folder ----------------------------------------------------------------------

  it('finds the documents whose files sit directly in one folder (docs/07 §7.3)', async () => {
    const reader = await createUser('folders@legere.local');
    const libraryId = await createLibrary('shelf');
    await libraryDocument(libraryId, 'At the top', 'top.pdf');
    await libraryDocument(libraryId, 'In the folder', 'travel/ticket.pdf');
    await libraryDocument(libraryId, 'Deeper still', 'travel/2019/ticket.pdf');

    const top = await documents.listInFolder(libraryId, '', reader, { limit: 10 });
    const inside = await documents.listInFolder(libraryId, 'travel', reader, { limit: 10 });

    expect(top.items.map((item) => item.document.title)).toEqual(['At the top']);
    expect(inside.items.map((item) => item.document.title)).toEqual(['In the folder']);
    // The rows carry the same derived shape as any other list.
    expect(inside.items[0]?.fileCount).toBe(1);
    expect(inside.items[0]?.availability).toBe('AVAILABLE');
  });

  // 🔒 A ref in a library the reader was granted does not make the document readable: the file it
  // points at may be a MANAGED one an upload created and a scan later deduplicated onto
  // (docs/05 §5.3, SEC-71). The browse asks the access rule like every other list (docs/03 §3.4).
  it('leaves out a document a ref reaches whose file is somebody else’s upload', async () => {
    const alice = await createUser('alice-folders@legere.local');
    const bob = await createUser('bob-folders@legere.local');
    const libraryId = await createLibrary('shared-shelf');

    // Alice uploads privately: a MANAGED file, a document she created.
    const fileId = await createFile({ origin: 'MANAGED' });
    const hers = await documents.create({ title: 'Her passport', createdById: alice.id });
    await files.attach(hers.id, fileId);
    // The same bytes then turn up on the volume, and ingest binds the ref to the row it already has
    // rather than making a second one (docs/05 §5.3).
    await addRef(libraryId, fileId, 'scans/passport.pdf');

    const forBob = await documents.listInFolder(libraryId, 'scans', bob, { limit: 10 });
    const forAlice = await documents.listInFolder(libraryId, 'scans', alice, { limit: 10 });

    expect(forBob.items).toEqual([]);
    expect(forAlice.items.map((item) => item.document.title)).toEqual(['Her passport']);
  });
});
