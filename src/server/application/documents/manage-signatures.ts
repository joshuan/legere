import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_SIGNATURE_BYTES,
  type DocumentSignatures,
  type FileSignatureDto,
  type OriginalSignatures,
} from '../../../shared/contracts/signatures';
import { canEditDocumentMeta } from '../../domain/entities/document';
import {
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../domain/errors/domain-error';
import type {
  DocumentDetail,
  DocumentFileView,
  Viewer,
} from '../../domain/repositories/document.repository';
import type {
  FileSignatureRecord,
  FileSignatureRepository,
} from '../../domain/repositories/file-signature.repository';
import { toBuffer } from '../ports/binary-source';
import type { FileStorage } from '../ports/file-storage';
import type { SignatureInspector } from '../ports/signature-inspector';
import type { DocumentFileBytes } from './document-file-bytes';
import { originOfDetail } from './manage-documents';
import { wholeFileReads } from './whole-file-reads';

const hashOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Discovery = Awaited<ReturnType<SignatureInspector['pdf']>>;

function dto(record: FileSignatureRecord): FileSignatureDto {
  return {
    id: record.id,
    source: 'DETACHED',
    name: record.name,
    contentHash: record.contentHash,
    sizeBytes: String(record.sizeBytes),
    createdAt: record.createdAt.toISOString(),
    report: record.report,
  };
}

export class ManageSignatures {
  // Cache reports only, never original bytes. In-flight work is shared across viewer requests.
  private readonly cache = new Map<string, { until: number; result: Promise<Discovery> }>();

  constructor(
    private readonly repository: FileSignatureRepository,
    private readonly storage: FileStorage,
    private readonly bytes: DocumentFileBytes,
    private readonly inspector: SignatureInspector,
    private readonly signedUrlTtlSec: number,
  ) {}

  async list(detail: DocumentDetail): Promise<DocumentSignatures> {
    const attachments = await this.repository.list(detail.files.map((file) => file.id));
    const files: OriginalSignatures[] = [];
    // Sequential reads keep one document with many originals from filling the process-wide gate.
    for (const file of detail.files) {
      const discovery = file.available
        ? await this.discover(file)
        : { discovery: 'UNAVAILABLE' as const, signatures: [] };
      files.push({
        fileId: file.id,
        fileName: file.name,
        originalHash: file.contentHash,
        discovery: discovery.discovery,
        signatures: [
          ...discovery.signatures,
          ...attachments
            .filter((item) => item.fileId === file.id && item.originalHash === file.contentHash)
            .map(dto),
        ],
      });
    }
    return { files };
  }

  async attach(
    viewer: Viewer,
    detail: DocumentDetail,
    fileId: string,
    name: string,
    signature: Buffer,
  ): Promise<FileSignatureDto> {
    const file = this.file(detail, fileId);
    if (!canEditDocumentMeta(viewer, detail.document, originOfDetail(detail)))
      throw new ForbiddenError();
    if (signature.length > MAX_SIGNATURE_BYTES || name.trim() === '') {
      throw new UnprocessableError(
        'SIGNATURE_INVALID',
        'The signature is too large or has no name',
      );
    }
    const report = await wholeFileReads.run(async () => {
      const original = await toBuffer(await this.bytes.open(file));
      if (hashOf(original) !== file.contentHash) {
        throw new UnprocessableError(
          'SIGNATURE_MISMATCH',
          'The original changed since it was archived',
        );
      }
      return this.inspector.detached(signature, original);
    });
    if (
      report.signers.some(
        (signer) => signer.verification === 'INVALID' || signer.digestMatch === false,
      )
    ) {
      throw new UnprocessableError(
        'SIGNATURE_MISMATCH',
        'This signature does not verify against the selected original',
      );
    }
    const id = randomUUID();
    const key = `files/${file.id}/signatures/${id}.sig`;
    await this.storage.put(key, signature, 'application/pkcs7-signature');
    let saved: FileSignatureRecord;
    try {
      saved = await this.repository.add({
        id,
        fileId,
        originalHash: file.contentHash,
        contentHash: hashOf(signature),
        name,
        sizeBytes: BigInt(signature.length),
        storageKey: key,
        report,
      });
    } catch (error: unknown) {
      await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
    if (saved.id !== id) await this.storage.delete(key).catch(() => undefined);
    return dto(saved);
  }

  async download(detail: DocumentDetail, fileId: string, signatureId: string): Promise<string> {
    const record = await this.record(detail, fileId, signatureId);
    return this.storage.getSignedUrl(record.storageKey, this.signedUrlTtlSec, {
      disposition: 'attachment',
      fileName: record.name,
      contentType: 'application/pkcs7-signature',
    });
  }

  async remove(detail: DocumentDetail, fileId: string, signatureId: string): Promise<{ ok: true }> {
    const record = await this.record(detail, fileId, signatureId);
    await this.repository.remove(record.id);
    await this.storage.delete(record.storageKey);
    return { ok: true };
  }

  private file(detail: DocumentDetail, fileId: string): DocumentFileView {
    const file = detail.files.find((item) => item.id === fileId);
    if (file === undefined) throw new NotFoundError('FILE_NOT_FOUND');
    return file;
  }

  private async record(
    detail: DocumentDetail,
    fileId: string,
    signatureId: string,
  ): Promise<FileSignatureRecord> {
    this.file(detail, fileId);
    const record = (await this.repository.list([fileId])).find((item) => item.id === signatureId);
    if (record === undefined) throw new NotFoundError('FILE_NOT_FOUND');
    return record;
  }

  private async discover(file: DocumentFileView): Promise<Discovery> {
    if (file.mimeType !== 'application/pdf') return { discovery: 'UNSUPPORTED', signatures: [] };
    const cached = this.cache.get(file.contentHash);
    if (cached !== undefined && cached.until > Date.now()) return cached.result;
    if (this.cache.size >= 128) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const result = wholeFileReads
      .run(async () => {
        const original = await toBuffer(await this.bytes.open(file));
        if (hashOf(original) !== file.contentHash)
          return { discovery: 'ERROR' as const, signatures: [] };
        return this.inspector.pdf(original);
      })
      .catch((): Discovery => {
        this.cache.delete(file.contentHash);
        return { discovery: 'ERROR', signatures: [] };
      });
    this.cache.set(file.contentHash, { until: Date.now() + 5 * 60_000, result });
    const discovered = await result;
    if (discovered.discovery !== 'COMPLETE') this.cache.delete(file.contentHash);
    return discovered;
  }
}
