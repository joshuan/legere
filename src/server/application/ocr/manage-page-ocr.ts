import type { PrepareOcrPage } from './prepare-ocr-page';
import { createHash, randomUUID } from 'node:crypto';
import {
  ocrResultSchema,
  type OcrRunDto,
  type OcrRunsResponse,
  type StartOcrInput,
} from '../../../shared/contracts/page-ocr';
import type { Document } from '../../domain/entities/document';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from '../../domain/errors/domain-error';
import type { Viewer } from '../../domain/repositories/document.repository';
import type {
  OcrRunRecord,
  PageOcrRepository,
} from '../../domain/repositories/page-ocr.repository';
import { toBuffer } from '../ports/binary-source';
import type { FileStorage } from '../ports/file-storage';
import type { JobQueue } from '../ports/job-queue';
import type { OcrProviders } from '../ports/page-ocr-provider';
import type { UnitOfWork } from '../ports/unit-of-work';
import { canonicalKeyOf } from '../storage/artifact-keys';

export class ManagePageOcr {
  constructor(
    private readonly repository: PageOcrRepository,
    private readonly providers: OcrProviders,
    private readonly queue: JobQueue,
    private readonly tx: UnitOfWork,
    private readonly files: FileStorage,
    private readonly ttl: number,
    private readonly images: PrepareOcrPage,
  ) {}

  async list(document: Document): Promise<OcrRunsResponse> {
    return {
      providers: this.providers.list(),
      pages: document.canonicalPageIds.map((id, at) => ({ id, number: at + 1 })),
      runs: (await this.repository.list(document.id)).map((run) => this.dto(run, document)),
    };
  }
  async get(document: Document, runId: string): Promise<OcrRunDto> {
    return this.dto(await this.run(document, runId), document);
  }
  async start(viewer: Viewer, document: Document, input: StartOcrInput): Promise<OcrRunDto> {
    this.admin(viewer);
    if (document.steps.canonical !== 'DONE' || document.canonicalPageIds.length === 0)
      throw new ConflictError('CANONICAL_NOT_READY');
    const selected = new Set(input.pageIds ?? document.canonicalPageIds);
    if (selected.size > 2000)
      throw new ValidationFailedError({ pageIds: 'At most 2000 pages per run' });
    if ([...selected].some((id) => !document.canonicalPageIds.includes(id)))
      throw new NotFoundError('DOCUMENT_NOT_FOUND');
    const providers = [...new Set(input.providers)].map((id) => this.providers.get(id).describe());
    if (providers.some((provider) => !provider.configured))
      throw new ConflictError('OCR_NOT_CONFIGURED');
    const canonicalKey = canonicalKeyOf(document);
    const languages = [...new Set(document.languages)].sort();
    const pages = document.canonicalPageIds.flatMap((pageId, at) =>
      selected.has(pageId)
        ? providers.map((provider) => {
            const model = provider.id === 'yandex-vision' ? input.yandexModel : provider.model;
            return {
              id: randomUUID(),
              pageId,
              pageNumber: at + 1,
              provider: provider.id,
              model,
              settingsHash: createHash('sha256')
                .update(
                  JSON.stringify({ provider: provider.id, model, languages, normalization: 1 }),
                )
                .digest('hex'),
            };
          })
        : [],
    );
    const run = await this.tx.run(
      async (tx) => {
        const created = await this.repository.create(
          {
            id: input.requestId,
            documentId: document.id,
            actorId: viewer.id,
            canonicalKey,
            languages,
            force: input.force,
            pages,
          },
          tx,
        );
        if (created.documentId !== document.id || created.actorId !== viewer.id)
          throw new NotFoundError('DOCUMENT_NOT_FOUND');
        for (const page of created.pages)
          if (page.status === 'QUEUED')
            await this.queue.enqueueAfterTx(
              tx,
              'page-ocr',
              { resultId: page.id, documentId: document.id },
              { singletonKey: page.id, priority: 10 },
            );
        return created;
      },
      { timeoutMs: 30_000 },
    );
    return this.dto(run, document);
  }
  async retry(viewer: Viewer, document: Document, runId: string): Promise<OcrRunDto> {
    this.admin(viewer);
    await this.run(document, runId);
    await this.tx.run(async (tx) => {
      for (const id of await this.repository.retryFailed(runId, tx))
        await this.queue.enqueueAfterTx(
          tx,
          'page-ocr',
          { resultId: id, documentId: document.id },
          { singletonKey: id, priority: 10 },
        );
    });
    return this.get(document, runId);
  }
  async result(document: Document, resultId: string) {
    const { page } = await this.page(document, resultId);
    if (page.resultKey === null) throw new ConflictError('OCR_NOT_READY');
    return ocrResultSchema.parse(
      JSON.parse(
        (await toBuffer(await this.files.getStream(page.resultKey), 32 * 1024 * 1024)).toString(
          'utf8',
        ),
      ),
    );
  }
  async artifact(
    document: Document,
    resultId: string,
    kind: 'image' | 'raw' | 'json',
  ): Promise<string> {
    const { page } = await this.page(document, resultId);
    const key = kind === 'image' ? page.imageKey : kind === 'raw' ? page.rawKey : page.resultKey;
    if (key === null) throw new ConflictError('OCR_NOT_READY');
    return this.files.getSignedUrl(
      key,
      this.ttl,
      kind === 'image'
        ? { disposition: 'inline', contentType: 'image/png' }
        : {
            disposition: 'attachment',
            contentType: 'application/json',
            fileName: `ocr-${page.pageNumber}-${page.provider}-${kind}.json`,
          },
    );
  }
  async pageImage(document: Document, pageId: string): Promise<string> {
    if (document.steps.canonical !== 'DONE') throw new ConflictError('CANONICAL_NOT_READY');
    const index = document.canonicalPageIds.indexOf(pageId);
    if (index < 0) throw new NotFoundError('DOCUMENT_NOT_FOUND');
    const image = await this.images.execute(
      document.id,
      canonicalKeyOf(document),
      pageId,
      index + 1,
    );
    return this.files.getSignedUrl(image.key, this.ttl, {
      disposition: 'inline',
      contentType: 'image/png',
    });
  }
  private async run(document: Document, id: string): Promise<OcrRunRecord> {
    const run = await this.repository.get(id);
    if (run === null || run.documentId !== document.id)
      throw new NotFoundError('DOCUMENT_NOT_FOUND');
    return run;
  }
  private async page(document: Document, id: string) {
    const found = await this.repository.findPage(id);
    if (found === null || found.run.documentId !== document.id)
      throw new NotFoundError('DOCUMENT_NOT_FOUND');
    return found;
  }
  private admin(viewer: Viewer): void {
    if (viewer.role !== 'ADMIN') throw new ForbiddenError();
  }
  private dto(run: OcrRunRecord, document: Document): OcrRunDto {
    return {
      id: run.id,
      createdAt: run.createdAt.toISOString(),
      stale: run.canonicalKey !== canonicalKeyOf(document) || document.steps.canonical !== 'DONE',
      pages: run.pages.map((page) => ({
        id: page.id,
        pageId: page.pageId,
        pageNumber: page.pageNumber,
        provider: page.provider,
        model: page.model,
        status: page.status,
        attempts: page.attempts,
        submittedAttempts: page.submittedAttempts,
        cached: page.cached,
        error: page.error,
        durationMs: page.durationMs,
        hasImage: page.imageKey !== null,
        hasRaw: page.rawKey !== null,
        completedAt: page.completedAt?.toISOString() ?? null,
      })),
    };
  }
}
