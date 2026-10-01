import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeDocumentEventRepository,
  ImmediateUnitOfWork,
  InMemoryFileRepository,
  fileFixture,
} from '../../../../test/helpers/processing-fakes';
import type { Receipt } from '../../domain/entities/receipt';
import type { Viewer } from '../../domain/repositories/document.repository';
import type { ReceiptRepository } from '../../domain/repositories/receipt.repository';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import type { JobQueue } from '../ports/job-queue';
import type { MimeDetector } from '../ports/mime-detector';
import { UploadReceipt } from './upload-receipt';

const VIEWER: Viewer = { id: '11111111-1111-4111-8111-111111111111', role: 'USER' };
const PDF = Buffer.from('%PDF-1.4\ntrailer\n%%EOF\n');
const HASH = createHash('sha256').update(PDF).digest('hex');

function receiptFixture(): Receipt {
  const file = fileFixture({
    origin: 'MANAGED',
    storageKey: 'files/existing/original.pdf',
    contentHash: HASH,
  });
  return {
    id: '22222222-2222-4222-8222-222222222222',
    fileId: file.id,
    file,
    pageCount: null,
    previewStatus: 'QUEUED',
    extractionStatus: 'QUEUED',
    extracted: null,
    sourceText: null,
    processingError: null,
    failedStep: null,
    createdById: VIEWER.id,
    createdAt: new Date('2026-09-25T00:00:00Z'),
    updatedAt: new Date('2026-09-25T00:00:00Z'),
    lastEventAt: new Date('2026-09-25T00:00:00Z'),
    deletedAt: null,
    reviewState: 'ACTIVE',
    reviewId: null,
    owner: { id: VIEWER.id, displayName: 'Owner' },
  };
}

describe('UploadReceipt', () => {
  const receipts = {
    lockByIds: vi.fn<ReceiptRepository['lockByIds']>(),
    setReviewState: vi.fn<ReceiptRepository['setReviewState']>(),
    countProcessing: vi.fn<ReceiptRepository['countProcessing']>(),
    lockStaleUnstarted: vi.fn<ReceiptRepository['lockStaleUnstarted']>(),
    lockFailedForRetry: vi.fn<ReceiptRepository['lockFailedForRetry']>(),
    create: vi.fn<ReceiptRepository['create']>(),
    findById: vi.fn<ReceiptRepository['findById']>(),
    findReadableById: vi.fn<ReceiptRepository['findReadableById']>(),
    findByFileId: vi.fn<ReceiptRepository['findByFileId']>(),
    list: vi.fn<ReceiptRepository['list']>(),
    updateProcessing: vi.fn<ReceiptRepository['updateProcessing']>(),
    filterExistingIds: vi.fn<ReceiptRepository['filterExistingIds']>(),
    hardDelete: vi.fn<ReceiptRepository['hardDelete']>(),
  } satisfies ReceiptRepository;
  const queue = {
    enqueue: vi.fn<JobQueue['enqueue']>(),
    enqueueAfterTx: vi.fn<JobQueue['enqueueAfterTx']>(),
    scheduleCron: vi.fn<JobQueue['scheduleCron']>(),
    unscheduleCron: vi.fn<JobQueue['unscheduleCron']>(),
  } satisfies JobQueue;
  const mime: MimeDetector = {
    detect: () => Promise.resolve({ mime: 'application/pdf', ext: 'pdf' }),
  };
  let files: InMemoryFileRepository;
  let storage: InMemoryFileStorage;
  let upload: UploadReceipt;

  beforeEach(() => {
    vi.resetAllMocks();
    files = new InMemoryFileRepository();
    storage = new InMemoryFileStorage();
    receipts.findByFileId.mockResolvedValue(null);
    receipts.create.mockResolvedValue(receiptFixture());
    upload = new UploadReceipt(
      receipts,
      files,
      new FakeDocumentEventRepository(),
      storage,
      mime,
      queue,
      new ImmediateUnitOfWork(),
    );
  });

  const send = () => upload.execute(VIEWER, { bytes: PDF, fileName: 'receipt.pdf' });

  it('refuses a concurrent private duplicate without returning its metadata or keeping its upload', async () => {
    const receipt = receiptFixture();
    files.add(receipt.file, null);
    vi.spyOn(files, 'findActiveByContentHash').mockResolvedValueOnce(null);
    receipts.findByFileId.mockResolvedValue(receipt);
    receipts.findReadableById.mockResolvedValue(null);

    await expect(send()).rejects.toMatchObject({ code: 'RECEIPT_DUPLICATE', httpStatus: 409 });

    expect(receipts.findReadableById).toHaveBeenCalledWith(receipt.id, VIEWER, expect.anything());
    expect(receipts.create).not.toHaveBeenCalled();
    expect(queue.enqueueAfterTx).not.toHaveBeenCalled();
    expect(storage.keys()).toEqual([]);
  });

  it('returns an accessible concurrent duplicate and discards only the losing object', async () => {
    const receipt = receiptFixture();
    files.add(receipt.file, null);
    await storage.put('files/existing/original.pdf', PDF, 'application/pdf');
    vi.spyOn(files, 'findActiveByContentHash').mockResolvedValueOnce(null);
    receipts.findByFileId.mockResolvedValue(receipt);
    receipts.findReadableById.mockResolvedValue(receipt);

    await expect(send()).resolves.toMatchObject({ created: false, receipt: { id: receipt.id } });
    expect(storage.keys()).toEqual(['files/existing/original.pdf']);
    expect(queue.enqueueAfterTx).not.toHaveBeenCalled();
  });

  it('creates a new receipt when reusing a trashed original and removes it from the trash', async () => {
    const receipt = receiptFixture();
    files.add({ ...receipt.file, trashedAt: new Date(), trashedReason: 'RECEIPT_DELETED' }, null);
    await storage.put('files/existing/original.pdf', PDF, 'application/pdf');

    await expect(send()).resolves.toMatchObject({ created: true });
    expect(await files.findById(receipt.fileId)).toMatchObject({ trashedAt: null });
    expect(storage.keys()).toEqual(['files/existing/original.pdf']);
    expect(queue.enqueueAfterTx).toHaveBeenCalledOnce();
  });

  it('cleans up the uploaded object when the creation transaction fails', async () => {
    receipts.create.mockRejectedValue(new Error('transaction failed'));
    await expect(send()).rejects.toThrow('transaction failed');
    expect(storage.keys()).toEqual([]);
  });
});
