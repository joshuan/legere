import type { PrepareOcrPage } from './prepare-ocr-page';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PageOcrRepository } from '../../domain/repositories/page-ocr.repository';
import { JobHandler, type JobDelivery } from '../jobs/job-handler';
import { toBuffer } from '../ports/binary-source';
import type { FileStorage } from '../ports/file-storage';
import { OcrProviderError, type OcrProviders } from '../ports/page-ocr-provider';
import { ServiceUnavailableError } from '../ports/service-unavailable';

const payloadSchema = z.object({ resultId: z.string().uuid() });
export class HandlePageOcr extends JobHandler {
  private readonly serial = new Map<string, Promise<void>>();
  constructor(
    private readonly repository: PageOcrRepository,
    private readonly providers: OcrProviders,
    private readonly images: PrepareOcrPage,
    private readonly files: FileStorage,
  ) {
    super();
  }
  async handle(payload: unknown, delivery: JobDelivery = { retryCount: 0 }): Promise<void> {
    const { resultId } = payloadSchema.parse(payload);
    const initial = await this.repository.findPage(resultId);
    if (initial === null || initial.page.status === 'DONE') return;
    // Permanent failures exhaust queue delivery without another cloud request; they remain
    // visible both in the OCR result and the existing administrative failure list.
    if (initial.page.status === 'FAILED')
      throw new OcrProviderError(initial.page.error ?? 'OCR failed', false);
    const token = randomUUID();
    if (!(await this.repository.claim(resultId, token, new Date())))
      throw new OcrProviderError('OCR page is already leased; delivery will retry', true);
    const started = Date.now();
    const heartbeat = setInterval(() => {
      void this.repository.heartbeat(resultId, token).catch(() => undefined);
    }, 30_000);
    heartbeat.unref();
    try {
      const { run, page } = initial;
      const image = await this.images.execute(
        run.documentId,
        run.canonicalKey,
        page.pageId,
        page.pageNumber,
      );
      if (
        !(await this.repository.update(resultId, token, {
          imageKey: image.key,
          imageHash: image.hash,
          width: image.width,
          height: image.height,
        }))
      )
        return;
      await this.serialized(
        JSON.stringify([run.documentId, image.hash, page.provider, page.settingsHash]),
        async () => {
          let rawKey = page.rawKey;
          let cached = page.cached;
          if (rawKey === null && !run.force) {
            const prior = await this.repository.cached(
              run.documentId,
              image.hash,
              page.provider,
              page.settingsHash,
            );
            rawKey = prior?.rawKey ?? null;
            cached = rawKey !== null;
          }
          const provider = this.providers.get(page.provider);
          let raw: unknown;
          if (rawKey !== null) {
            raw = JSON.parse(
              (await toBuffer(await this.files.getStream(rawKey), 32 * 1024 * 1024)).toString(
                'utf8',
              ),
            );
          } else {
            raw = await provider.recognize(
              image,
              { model: page.model, languages: run.languages },
              async () => {
                if (!(await this.repository.submitted(resultId, token)))
                  throw new OcrProviderError('OCR lease was lost before submission', false);
              },
            );
            rawKey = `documents/${run.documentId}/ocr/results/${resultId}/${token}-raw.json`;
            await this.files.put(rawKey, Buffer.from(JSON.stringify(raw)), 'application/json');
          }
          if (!(await this.repository.update(resultId, token, { rawKey, cached }))) return;
          const normalized = provider.normalize(raw, {
            pageId: page.pageId,
            imageHash: image.hash,
            width: image.width,
            height: image.height,
            model: page.model,
          });
          const resultKey = `documents/${run.documentId}/ocr/results/${resultId}/${token}.json`;
          await this.files.put(
            resultKey,
            Buffer.from(JSON.stringify(normalized)),
            'application/json',
          );
          await this.repository.update(
            resultId,
            token,
            {
              status: 'DONE',
              resultKey,
              durationMs: Date.now() - started,
              completedAt: new Date(),
            },
            true,
          );
        },
      );
    } catch (error) {
      const retryable =
        error instanceof ServiceUnavailableError ||
        (error instanceof OcrProviderError && error.retryable);
      // Schema failures never include provider text in their public error message.
      const message =
        error instanceof z.ZodError
          ? 'The OCR response does not match the supported format; original JSON is retained'
          : error instanceof Error
            ? error.message.slice(0, 500)
            : 'OCR failed';
      await this.repository.update(
        resultId,
        token,
        {
          status: retryable && delivery.retryCount < 5 ? 'QUEUED' : 'FAILED',
          error: message,
          durationMs: Date.now() - started,
        },
        true,
      );
      throw new OcrProviderError(message, retryable);
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async serialized(key: string, work: () => Promise<void>): Promise<void> {
    const before = this.serial.get(key) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(work);
    this.serial.set(key, next);
    try {
      await next;
    } finally {
      if (this.serial.get(key) === next) this.serial.delete(key);
    }
  }
}
