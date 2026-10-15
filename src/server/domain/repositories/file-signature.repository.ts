import type { SignatureReport } from '../../../shared/contracts/signatures';

export type FileSignatureRecord = {
  id: string;
  fileId: string;
  contentHash: string;
  originalHash: string;
  name: string;
  sizeBytes: bigint;
  storageKey: string;
  report: SignatureReport;
  createdAt: Date;
};

export abstract class FileSignatureRepository {
  abstract list(fileIds: readonly string[]): Promise<FileSignatureRecord[]>;
  // Atomically idempotent and bounded per File. Returns the existing row for a duplicate.
  abstract add(input: Omit<FileSignatureRecord, 'createdAt'>): Promise<FileSignatureRecord>;
  abstract remove(id: string): Promise<void>;
}
