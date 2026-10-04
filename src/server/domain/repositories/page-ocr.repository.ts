import type { OcrProviderId, OcrStatus } from '../../../shared/contracts/page-ocr';
import type { TransactionHandle } from '../../application/ports/unit-of-work';

export type OcrPageRecord = {
  id: string;
  runId: string;
  pageId: string;
  pageNumber: number;
  provider: OcrProviderId;
  model: string;
  settingsHash: string;
  status: OcrStatus;
  attempts: number;
  submittedAttempts: number;
  cached: boolean;
  imageKey: string | null;
  imageHash: string | null;
  width: number | null;
  height: number | null;
  rawKey: string | null;
  resultKey: string | null;
  error: string | null;
  durationMs: number | null;
  completedAt: Date | null;
};
export type OcrRunRecord = {
  id: string;
  documentId: string;
  actorId: string;
  canonicalKey: string;
  languages: string[];
  force: boolean;
  createdAt: Date;
  pages: OcrPageRecord[];
};
export type OcrImageRecord = {
  documentId: string;
  canonicalKey: string;
  pageId: string;
  imageKey: string;
  imageHash: string;
  width: number;
  height: number;
  dpi: number;
};
export type CreateOcrRun = Omit<OcrRunRecord, 'createdAt' | 'pages'> & {
  pages: Array<
    Pick<OcrPageRecord, 'id' | 'pageId' | 'pageNumber' | 'provider' | 'model' | 'settingsHash'>
  >;
};
export type OcrPageUpdate = Partial<
  Pick<
    OcrPageRecord,
    | 'status'
    | 'cached'
    | 'imageKey'
    | 'imageHash'
    | 'width'
    | 'height'
    | 'rawKey'
    | 'resultKey'
    | 'error'
    | 'durationMs'
    | 'completedAt'
  >
>;

export abstract class PageOcrRepository {
  abstract create(input: CreateOcrRun, tx: TransactionHandle): Promise<OcrRunRecord>;
  abstract list(documentId: string): Promise<OcrRunRecord[]>;
  abstract get(runId: string): Promise<OcrRunRecord | null>;
  abstract findPage(id: string): Promise<{ run: OcrRunRecord; page: OcrPageRecord } | null>;
  abstract claim(id: string, token: string, now: Date): Promise<boolean>;
  abstract update(
    id: string,
    token: string,
    patch: OcrPageUpdate,
    release?: boolean,
  ): Promise<boolean>;
  abstract heartbeat(id: string, token: string): Promise<void>;
  abstract submitted(id: string, token: string): Promise<boolean>;
  abstract retryFailed(runId: string, tx: TransactionHandle): Promise<string[]>;
  abstract findImage(
    documentId: string,
    canonicalKey: string,
    pageId: string,
  ): Promise<OcrImageRecord | null>;
  abstract saveImage(image: OcrImageRecord): Promise<OcrImageRecord>;
  abstract cached(
    documentId: string,
    imageHash: string,
    provider: OcrProviderId,
    settingsHash: string,
  ): Promise<OcrPageRecord | null>;
}
