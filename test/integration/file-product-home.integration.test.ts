import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pagesForFile } from '../../src/server/domain/entities/document-page';
import { ArchiveItemRepository } from '../../src/server/domain/repositories/archive-item.repository';
import { DocumentRepository } from '../../src/server/domain/repositories/document.repository';
import { FileRepository } from '../../src/server/domain/repositories/file.repository';
import { ReceiptRepository } from '../../src/server/domain/repositories/receipt.repository';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { PrismaService } from '../../src/server/infrastructure/persistence/prisma.service';
import { disconnectTestPrisma, truncateAll } from '../helpers/db';

describe('File product ownership (integration)', () => {
  let prisma: PrismaService;
  let files: FileRepository;
  let documents: DocumentRepository;
  let receipts: ReceiptRepository;
  let archiveItems: ArchiveItemRepository;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PersistenceModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    files = moduleRef.get(FileRepository);
    documents = moduleRef.get(DocumentRepository);
    receipts = moduleRef.get(ReceiptRepository);
    archiveItems = moduleRef.get(ArchiveItemRepository);
    close = () => moduleRef.close();
    await truncateAll();
  });

  afterEach(() => truncateAll());
  afterAll(async () => {
    await close();
    await disconnectTestPrisma();
  });

  const fileInput = {
    contentHash: '1'.repeat(64),
    origin: 'MANAGED' as const,
    storageKey: 'files/original.pdf',
    mimeType: 'application/pdf',
    ext: 'pdf',
    sizeBytes: 100n,
    name: 'original.pdf',
  };

  async function fixture() {
    const owner = await prisma.user.create({
      data: { email: 'owner@legere.local', displayName: 'Owner', passwordHash: 'x', role: 'USER' },
    });
    const document = await documents.create({ title: 'Document', createdById: owner.id });
    const { file } = await files.findOrCreateByContentHash(fileInput);
    return { owner, document, file };
  }

  it('refuses both append and replacement when an original already belongs to a receipt', async () => {
    const { owner, document, file } = await fixture();
    await receipts.create({ fileId: file.id, createdById: owner.id });

    await expect(files.appendPages(document.id, pagesForFile(file))).rejects.toMatchObject({
      code: 'RECEIPT_DUPLICATE',
    });
    await expect(
      files.replacePages(document.id, { pages: pagesForFile(file), expecting: null }),
    ).rejects.toMatchObject({ code: 'RECEIPT_DUPLICATE' });
    expect(await files.listPagesForDocument(document.id)).toEqual([]);
    expect(await prisma.receipt.count()).toBe(1);
  });

  it('refuses a receipt when a live document already reads the original', async () => {
    const { owner, document, file } = await fixture();
    await files.appendPages(document.id, pagesForFile(file));

    await expect(receipts.create({ fileId: file.id, createdById: owner.id })).rejects.toMatchObject(
      { code: 'RECEIPT_DUPLICATE' },
    );
    expect(await prisma.receipt.count()).toBe(0);
    expect(await prisma.archiveItem.count()).toBe(1);
  });

  it('serializes competing product claims so only one transaction can commit', async () => {
    const { owner, document, file } = await fixture();
    const outcomes = await Promise.allSettled([
      prisma.$transaction((tx) => files.appendPages(document.id, pagesForFile(file), tx)),
      prisma.$transaction((tx) => receipts.create({ fileId: file.id, createdById: owner.id }, tx)),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: { httpStatus: 409 },
    });
    expect((await prisma.documentPage.count()) + (await prisma.receipt.count())).toBe(1);
  });

  it('serializes creation of identical hashes without leaving a transaction aborted', async () => {
    const outcomes = await Promise.all([
      prisma.$transaction((tx) => files.findOrCreateByContentHash(fileInput, tx)),
      prisma.$transaction((tx) => files.findOrCreateByContentHash(fileInput, tx)),
    ]);

    expect(outcomes[0]?.file.id).toBe(outcomes[1]?.file.id);
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(await prisma.file.count()).toBe(1);
  });

  it.each(['reorder', 'expand'] as const)(
    'allows %s alongside a split without adding a file/document lock cycle',
    async (operation) => {
      const { document, file } = await fixture();
      await files.appendPages(document.id, pagesForFile(file));
      const splitDocument = await documents.create({ title: 'Split' });
      let fileLocked = (): void => undefined;
      const fileHeld = new Promise<void>((resolve) => {
        fileLocked = resolve;
      });
      let originalLocked = (): void => undefined;
      const originalHeld = new Promise<void>((resolve) => {
        originalLocked = resolve;
      });

      const split = prisma.$transaction(async (tx) => {
        // A split first populates its new document, then removes the old entries.
        await files.replacePages(
          splitDocument.id,
          { pages: pagesForFile(file), expecting: null },
          tx,
        );
        fileLocked();
        await originalHeld;
        await files.replacePages(document.id, { pages: [], expecting: null }, tx);
      });
      const edit = prisma.$transaction(async (tx) => {
        await fileHeld;
        await files.lockPagesForDocument(document.id, tx);
        originalLocked();
        await documents.updateMeta(document.id, { title: 'Concurrent edit' }, tx);
        if (operation === 'expand') {
          await files.expandWholeFileEntries(document.id, new Map([[file.id, 2]]), tx);
        } else {
          await files.replacePages(document.id, { pages: pagesForFile(file), expecting: null }, tx);
        }
      });

      const outcomes = await Promise.allSettled([split, edit]);
      expect(outcomes[0]).toMatchObject({ status: 'fulfilled' });
      expect(outcomes[1]).toMatchObject({ status: 'fulfilled' });
      expect(await files.listPagesForDocument(document.id)).toEqual([]);
      expect(await files.listForDocument(splitDocument.id)).toHaveLength(1);
      expect(await documents.findById(document.id)).toMatchObject({ title: 'Concurrent edit' });
    },
  );

  it('refuses a document writer immediately during a receipt claim and rolls its edits back', async () => {
    const { owner, document, file } = await fixture();
    let receiptLocked = (): void => undefined;
    const receiptHeld = new Promise<void>((resolve) => {
      receiptLocked = resolve;
    });
    let editFinished = (): void => undefined;
    const editDone = new Promise<void>((resolve) => {
      editFinished = resolve;
    });

    const claim = prisma.$transaction(async (tx) => {
      await receipts.create({ fileId: file.id, createdById: owner.id }, tx);
      receiptLocked();
      await editDone;
    });
    const edit = prisma.$transaction(async (tx) => {
      await receiptHeld;
      try {
        await documents.updateMeta(document.id, { title: 'Must roll back' }, tx);
        await files.appendPages(document.id, pagesForFile(file), tx);
      } finally {
        editFinished();
      }
    });

    const outcomes = await Promise.allSettled([claim, edit]);
    expect(outcomes[0]).toMatchObject({ status: 'fulfilled' });
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { code: 'DOCUMENT_CHANGED' } });
    expect(await documents.findById(document.id)).toMatchObject({ title: 'Document' });
    expect(await files.listPagesForDocument(document.id)).toEqual([]);
    expect(await prisma.receipt.count()).toBe(1);
  });

  it('rechecks other document readers during conversion and rolls back the deleted profile', async () => {
    const { owner, document, file } = await fixture();
    const other = await documents.create({ title: 'Other', createdById: owner.id });
    await files.appendPages(document.id, pagesForFile(file));
    await files.appendPages(other.id, pagesForFile(file));

    await expect(
      prisma.$transaction((tx) =>
        archiveItems.documentToReceipt({ id: document.id, fileId: file.id, ownerId: owner.id }, tx),
      ),
    ).rejects.toMatchObject({ code: 'RECEIPT_DUPLICATE' });

    expect(await files.listDocumentIdsForFile(file.id)).toEqual([document.id, other.id].sort());
    expect(await prisma.receipt.count()).toBe(0);
  });
});
