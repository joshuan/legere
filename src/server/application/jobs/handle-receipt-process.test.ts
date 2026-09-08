import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeAnalyst,
  FakeDocumentEventRepository,
  FakeImageTool,
  FakePdfToolbox,
  InMemoryFileRepository,
  fileFixture,
} from '../../../../test/helpers/processing-fakes';
import type { Receipt } from '../../domain/entities/receipt';
import type { Viewer } from '../../domain/repositories/document.repository';
import {
  ReceiptRepository,
  type ReceiptProcessingUpdate,
} from '../../domain/repositories/receipt.repository';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { artifactKeys, originalKeyOf } from '../storage/artifact-keys';
import { HandleReceiptProcess } from './handle-receipt-process';

const RECEIPT_ID = '77777777-7777-4777-8777-777777777777';
const OWNER_ID = '88888888-8888-4888-8888-888888888888';
const SOURCE_TEXT = '<html>Order 42 — Voli, EUR 12.40</html>';

function receiptFixture(overrides: Partial<Receipt> = {}): Receipt {
  const file = fileFixture({
    origin: 'MANAGED',
    storageKey: 'files/55555555-5555-4555-8555-555555555555/original.pdf',
  });
  return {
    id: RECEIPT_ID,
    fileId: file.id,
    file,
    pageCount: null,
    previewStatus: 'QUEUED',
    extractionStatus: 'QUEUED',
    extracted: null,
    sourceText: SOURCE_TEXT,
    processingError: null,
    failedStep: null,
    createdById: OWNER_ID,
    createdAt: new Date('2026-09-08T00:00:00.000Z'),
    updatedAt: new Date('2026-09-08T00:00:00.000Z'),
    lastEventAt: new Date('2026-09-08T00:00:00.000Z'),
    deletedAt: null,
    owner: { id: OWNER_ID, displayName: 'Receipt owner' },
    ...overrides,
  };
}

class InMemoryReceiptRepository extends ReceiptRepository {
  receipt: Receipt | null = receiptFixture();
  readonly updates: ReceiptProcessingUpdate[] = [];

  create(): Promise<Receipt> {
    throw new Error('create is not used by receipt processing');
  }

  findById(id: string): Promise<Receipt | null> {
    return Promise.resolve(this.receipt?.id === id ? this.receipt : null);
  }

  findReadableById(_id: string, _viewer: Viewer): Promise<Receipt | null> {
    throw new Error('findReadableById is not used by receipt processing');
  }

  findByFileId(): Promise<Receipt | null> {
    throw new Error('findByFileId is not used by receipt processing');
  }

  list(): Promise<{ items: Receipt[]; nextCursor: string | null }> {
    throw new Error('list is not used by receipt processing');
  }

  updateProcessing(id: string, update: ReceiptProcessingUpdate): Promise<Receipt> {
    if (this.receipt === null || this.receipt.id !== id) throw new Error(`No receipt ${id}`);
    this.updates.push(update);
    this.receipt = { ...this.receipt, ...update };
    return Promise.resolve(this.receipt);
  }

  filterExistingIds(ids: string[]): Promise<string[]> {
    return Promise.resolve(
      this.receipt === null ? [] : ids.filter((id) => id === this.receipt?.id),
    );
  }

  softDelete(): Promise<void> {
    throw new Error('softDelete is not used by receipt processing');
  }

  hardDelete(): Promise<void> {
    throw new Error('hardDelete is not used by receipt processing');
  }
}

describe('HandleReceiptProcess', () => {
  let receipts: InMemoryReceiptRepository;
  let files: InMemoryFileRepository;
  let events: FakeDocumentEventRepository;
  let storage: InMemoryFileStorage;
  let pdfs: FakePdfToolbox;
  let images: FakeImageTool;
  let analyst: FakeAnalyst;
  let handler: HandleReceiptProcess;

  beforeEach(async () => {
    receipts = new InMemoryReceiptRepository();
    files = new InMemoryFileRepository();
    events = new FakeDocumentEventRepository();
    storage = new InMemoryFileStorage();
    pdfs = new FakePdfToolbox();
    images = new FakeImageTool();
    analyst = new FakeAnalyst();
    const receipt = receiptFixture();
    receipts.receipt = receipt;
    files.add(receipt.file, null);
    await storage.put(originalKeyOf(receipt.file), Buffer.from('original-pdf'), 'application/pdf');
    handler = new HandleReceiptProcess(receipts, files, events, storage, pdfs, images, analyst, {
      previewMaxDim: 1800,
      thumbMaxDim: 360,
      analystPageImageMaxDim: 1400,
    });
  });

  it('renders every PDF page and sends the caller text beside those images to field extraction', async () => {
    pdfs.pageCount = 2;
    analyst.fieldValues = {
      vendor: '  Voli  ',
      vendorAddress: '  Bulevar Revolucije 5, 85000 Bar  ',
      country: 'ME',
      city: 'Bar',
      purchasedAt: '2026-09-07',
      total: { amount: '12.40', currency: 'EUR' },
      items: [
        {
          name: 'Coffee',
          amount: '4,20',
          taxCode: 'A',
          taxRate: '21',
          taxAmount: '0,73',
        },
      ],
      invented: 'discard me',
    };
    analyst.fieldConfidence = 93;

    await handler.handle({ receiptId: RECEIPT_ID });

    expect(analyst.fieldCalls).toEqual([
      {
        schemaSlug: 'receipt',
        excerpt: SOURCE_TEXT,
        pages: 2,
        confirmed: {},
      },
    ]);
    expect(receipts.receipt).toMatchObject({
      pageCount: 2,
      previewStatus: 'DONE',
      extractionStatus: 'DONE',
      extracted: {
        schema: { slug: 'receipt', version: 3 },
        confidence: 93,
        values: {
          vendor: 'Voli',
          vendorAddress: 'Bulevar Revolucije 5, 85000 Bar',
          country: 'ME',
          city: 'Bar',
          purchasedAt: '2026-09-07',
          total: { amount: 12.4, currency: 'EUR' },
          items: [
            {
              name: 'Coffee',
              amount: 4.2,
              taxCode: 'A',
              taxRate: 21,
              taxAmount: 0.73,
            },
          ],
        },
      },
    });
    expect(pdfs.calls).toEqual([
      { method: 'pdfPageCount' },
      { method: 'pdfPageJpg', fileName: 'page:1' },
      { method: 'pdfPageJpg', fileName: 'page:2' },
    ]);
    expect(storage.keys()).toEqual([
      originalKeyOf(receiptFixture().file),
      artifactKeys.receiptPage(RECEIPT_ID, 0),
      artifactKeys.receiptPage(RECEIPT_ID, 1),
      artifactKeys.receiptThumbnail(RECEIPT_ID),
    ]);
    expect(files.files.get(receiptFixture().file.id)?.pageCount).toBe(2);
  });

  it('keeps the preview viewable and marks extraction skipped when AI is not configured', async () => {
    analyst.configured = false;

    await handler.handle({ receiptId: RECEIPT_ID });

    expect(receipts.receipt).toMatchObject({
      previewStatus: 'DONE',
      extractionStatus: 'SKIPPED',
    });
    expect(analyst.fieldCalls).toEqual([]);
    expect(events.events.at(-1)).toMatchObject({
      documentId: RECEIPT_ID,
      type: 'STEP_FINISHED',
      payload: { step: 'extraction', status: 'SKIPPED', reason: 'NOT_CONFIGURED' },
    });
  });
});
