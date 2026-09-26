import argon2 from 'argon2';
import { artifactKeys } from '../../src/server/application/storage/artifact-keys';
import { testPrisma, truncateAll } from '../helpers/db';
import { seedDocument } from '../helpers/documents';
import {
  VISUAL_EMAIL,
  VISUAL_IDS,
  VISUAL_NOW,
  VISUAL_PASSWORD,
  VISUAL_RECEIPT_SOURCE,
} from './constants';

// Meaningful fixtures belong only to a dedicated test database. The ordinary development seed
// remains unchanged, and all browser authentication still goes through the real login endpoint.
export async function seedBrowserData(): Promise<string[]> {
  await truncateAll();
  const prisma = testPrisma();
  const now = new Date(VISUAL_NOW);
  const dates = { createdAt: now, updatedAt: now };
  await prisma.user.create({
    data: {
      id: VISUAL_IDS.user,
      email: VISUAL_EMAIL,
      displayName: 'Alex Morgan',
      passwordHash: await argon2.hash(VISUAL_PASSWORD),
      role: 'ADMIN',
      language: 'EN',
      theme: 'SYSTEM',
      ...dates,
    },
  });
  await prisma.user.create({
    data: {
      id: '10000000-0000-4000-8000-000000000002',
      email: 'reader@example.test',
      displayName: 'Sam Rivera',
      passwordHash: await argon2.hash(VISUAL_PASSWORD),
      role: 'USER',
      language: 'EN',
      ...dates,
    },
  });
  await prisma.library.create({
    data: {
      id: VISUAL_IDS.library,
      name: 'Family archive',
      rootPath: '',
      enabled: false,
      visibility: 'ALL_USERS',
      excludeGlobs: ['**/.*'],
      scanIntervalMinutes: 30,
      ...dates,
    },
  });
  await prisma.scanRun.create({
    data: {
      id: 'b0000000-0000-4000-8000-000000000001',
      libraryId: VISUAL_IDS.library,
      status: 'DONE',
      startedAt: new Date('2026-09-24T08:00:00.000Z'),
      finishedAt: new Date('2026-09-24T08:02:00.000Z'),
      filesSeen: 8,
      filesNew: 3,
      filesChanged: 1,
      filesMissing: 0,
    },
  });
  await prisma.documentType.create({
    data: {
      id: VISUAL_IDS.type,
      slug: 'contract',
      name: 'Contract',
      description: 'Agreements, contracts and addenda.',
      ...dates,
    },
  });
  await prisma.documentType.create({
    data: {
      id: '80000000-0000-4000-8000-000000000002',
      slug: 'invoice',
      name: 'Invoice',
      description: 'Invoices and bills.',
      ...dates,
    },
  });
  await prisma.person.create({
    data: {
      id: VISUAL_IDS.person,
      name: 'Alex Morgan',
      nameFolded: 'alex morgan',
      note: 'Household documents and travel records',
      ...dates,
    },
  });
  await prisma.subjectKind.create({
    data: {
      id: VISUAL_IDS.kind,
      name: 'Apartment',
      nameFolded: 'apartment',
      note: 'Homes and rental properties',
      ...dates,
    },
  });
  await prisma.subject.create({
    data: {
      id: VISUAL_IDS.subject,
      kindId: VISUAL_IDS.kind,
      name: 'Riverside apartment',
      nameFolded: 'riverside apartment',
      note: '12 Riverside Road, Belgrade',
      ...dates,
    },
  });
  const keys: string[] = [];
  const titles = [
    'Riverside apartment rental agreement',
    'September electricity invoice',
    'Travel insurance confirmation',
    'Home maintenance and warranty records',
  ];
  for (const [index, title] of titles.entries()) {
    const document = await seedDocument({
      libraryId: VISUAL_IDS.library,
      document: {
        id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        title,
        titleSource: 'MANUAL',
        typeId: VISUAL_IDS.type,
        typeSource: 'MANUAL',
        pageCount: 2,
        description: 'A signed household record with the essential dates, parties and references.',
        markdown:
          '# Rental agreement\n\nA clear record of the rental terms for **Riverside apartment**.\n\n## Parties\n\nAlex Morgan and Riverside Housing.\n\n| Term | Value |\n| --- | --- |\n| Monthly rent | EUR 850 |\n| Start date | 1 September 2026 |',
        languages: ['en'],
        documentDate: new Date('2026-09-01T00:00:00.000Z'),
        country: 'RS',
        city: 'Belgrade',
        createdById: VISUAL_IDS.user,
        lastEventAt: now,
        ...dates,
        ...(index === 3
          ? {
              analysisStatus: 'FAILED',
              failedStep: 'analysis',
              processingError: 'The analysis provider did not respond. Retry is available.',
            }
          : {}),
      },
      files: [
        {
          id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          name: `household-record-${index + 1}.pdf`,
          pageCount: 2,
          path: `Household/record-${index + 1}.pdf`,
          mtime: now,
        },
      ],
    });
    await prisma.documentPerson.create({
      data: { documentId: document.id, personId: VISUAL_IDS.person, createdAt: now },
    });
    await prisma.documentSubject.create({
      data: { documentId: document.id, subjectId: VISUAL_IDS.subject, createdAt: now },
    });
    keys.push(
      artifactKeys.preview(document.id),
      artifactKeys.thumbnail(document.id),
      artifactKeys.canonicalPdf(document.id),
    );
    for (const fileId of document.fileIds) {
      keys.push(artifactKeys.filePageThumb(fileId, 0), artifactKeys.filePageThumb(fileId, 1));
    }
  }
  await prisma.collection.create({
    data: {
      id: VISUAL_IDS.collection,
      ownerId: VISUAL_IDS.user,
      name: 'Moving to Riverside',
      description: 'Everything needed for our new apartment, kept together.',
      items: {
        create: { documentId: VISUAL_IDS.document, addedById: VISUAL_IDS.user, addedAt: now },
      },
      ...dates,
    },
  });
  for (const [index, vendor] of ['Riverside Market', 'Stationery & Office Supplies'].entries()) {
    const receiptId = index === 0 ? VISUAL_IDS.receipt : '40000000-0000-4000-8000-000000000002';
    const file = await prisma.file.create({
      data: {
        id: `a0000000-0000-4000-8000-${String(index + 7).padStart(12, '0')}`,
        contentHash: String(index + 7).repeat(64),
        origin: 'MANAGED',
        storageKey: `fixtures/receipt-${index + 1}.jpg`,
        mimeType: 'image/jpeg',
        ext: 'jpg',
        sizeBytes: 183240n,
        name: `receipt-${index + 1}.jpg`,
        pageCount: 1,
        ...dates,
      },
    });
    await prisma.archiveItem.create({
      data: {
        id: receiptId,
        kind: 'RECEIPT',
        createdById: VISUAL_IDS.user,
        lastEventAt: now,
        ...dates,
      },
    });
    await prisma.receipt.create({
      data: {
        id: receiptId,
        fileId: file.id,
        pageCount: 1,
        previewStatus: 'DONE',
        extractionStatus: 'DONE',
        sourceText: VISUAL_RECEIPT_SOURCE,
        vendor,
        purchasedAt: new Date('2026-09-23T00:00:00.000Z'),
        country: 'RS',
        currency: 'EUR',
        totalAmount: 24.8,
        extracted: {
          schema: { slug: 'receipt', version: 1 },
          confidence: 96,
          values: {
            vendor,
            purchasedAt: '2026-09-23',
            country: 'RS',
            currency: 'EUR',
            total: { amount: 24.8, currency: 'EUR' },
            items: [
              { name: 'Whole grain bread', quantity: 2, unitPrice: 3.4, amount: 6.8 },
              { name: 'Seasonal groceries', quantity: 1, unitPrice: 18, amount: 18 },
            ],
          },
        },
      },
    });
    keys.push(artifactKeys.receiptThumbnail(receiptId), artifactKeys.receiptPage(receiptId, 0));
  }
  await prisma.file.create({
    data: {
      id: 'a0000000-0000-4000-8000-000000000099',
      contentHash: 'f'.repeat(64),
      origin: 'MANAGED',
      storageKey: 'fixtures/old-scan.pdf',
      mimeType: 'application/pdf',
      ext: 'pdf',
      sizeBytes: 4096n,
      name: 'Superseded household scan.pdf',
      trashedAt: now,
      trashedReason: 'DOCUMENT_DELETED',
      trashedFrom: 'An older household record',
      trashedArchiveKind: 'DOCUMENT',
      trashedOwnerId: VISUAL_IDS.user,
      ...dates,
    },
  });
  keys.push('fixtures/old-scan.pdf');
  return keys;
}
