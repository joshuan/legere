import { Injectable } from '@nestjs/common';
import type { OcrPageResult, OcrRun } from '@prisma/client';
import {
  ocrProviderSchema,
  ocrStatusSchema,
  type OcrProviderId,
} from '../../../shared/contracts/page-ocr';
import {
  PageOcrRepository,
  type CreateOcrRun,
  type OcrImageRecord,
  type OcrPageRecord,
  type OcrPageUpdate,
  type OcrRunRecord,
} from '../../domain/repositories/page-ocr.repository';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function pageOf(row: OcrPageResult): OcrPageRecord {
  return {
    ...row,
    provider: ocrProviderSchema.parse(row.provider),
    status: ocrStatusSchema.parse(row.status),
  };
}
function runOf(row: OcrRun & { pages: OcrPageResult[] }): OcrRunRecord {
  return { ...row, pages: row.pages.map(pageOf) };
}
const include = {
  pages: { orderBy: [{ pageNumber: 'asc' as const }, { provider: 'asc' as const }] },
};

@Injectable()
export class PrismaPageOcrRepository extends PageOcrRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }
  async create(input: CreateOcrRun, tx: TransactionHandle): Promise<OcrRunRecord> {
    const { pages, ...run } = input;
    return runOf(
      await clientOf(this.prisma, tx).ocrRun.upsert({
        where: { id: run.id },
        update: {},
        create: { ...run, pages: { create: pages } },
        include,
      }),
    );
  }
  async list(documentId: string): Promise<OcrRunRecord[]> {
    return (
      await this.prisma.ocrRun.findMany({
        where: { documentId },
        orderBy: { createdAt: 'desc' },
        take: 30,
        include,
      })
    ).map(runOf);
  }
  async get(id: string): Promise<OcrRunRecord | null> {
    const row = await this.prisma.ocrRun.findUnique({ where: { id }, include });
    return row === null ? null : runOf(row);
  }
  async findPage(id: string) {
    const row = await this.prisma.ocrPageResult.findUnique({
      where: { id },
      include: { run: { include } },
    });
    return row === null ? null : { run: runOf(row.run), page: pageOf(row) };
  }
  async claim(id: string, token: string, now: Date): Promise<boolean> {
    const result = await this.prisma.ocrPageResult.updateMany({
      where: {
        id,
        status: { in: ['QUEUED', 'RUNNING'] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: {
        status: 'RUNNING',
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + 10 * 60_000),
        attempts: { increment: 1 },
        error: null,
      },
    });
    return result.count === 1;
  }
  async update(id: string, token: string, patch: OcrPageUpdate, release = false): Promise<boolean> {
    const result = await this.prisma.ocrPageResult.updateMany({
      where: { id, leaseToken: token },
      data: { ...patch, ...(release ? { leaseToken: null, leaseUntil: null } : {}) },
    });
    return result.count === 1;
  }
  async heartbeat(id: string, token: string): Promise<void> {
    await this.prisma.ocrPageResult.updateMany({
      where: { id, leaseToken: token, status: 'RUNNING' },
      data: { leaseUntil: new Date(Date.now() + 10 * 60_000) },
    });
  }
  async submitted(id: string, token: string): Promise<boolean> {
    return (
      (
        await this.prisma.ocrPageResult.updateMany({
          where: { id, leaseToken: token },
          data: { submittedAttempts: { increment: 1 } },
        })
      ).count === 1
    );
  }
  async retryFailed(runId: string, tx: TransactionHandle): Promise<string[]> {
    const client = clientOf(this.prisma, tx);
    const rows = await client.ocrPageResult.findMany({
      where: { runId, status: 'FAILED' },
      select: { id: true },
    });
    await client.ocrPageResult.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, status: 'FAILED' },
      data: {
        status: 'QUEUED',
        error: null,
        leaseToken: null,
        leaseUntil: null,
        completedAt: null,
      },
    });
    return rows.map((row) => row.id);
  }
  findImage(
    documentId: string,
    canonicalKey: string,
    pageId: string,
  ): Promise<OcrImageRecord | null> {
    return this.prisma.ocrPageImage.findUnique({
      where: { documentId_canonicalKey_pageId: { documentId, canonicalKey, pageId } },
    });
  }
  saveImage(image: OcrImageRecord): Promise<OcrImageRecord> {
    return this.prisma.ocrPageImage.upsert({
      where: {
        documentId_canonicalKey_pageId: {
          documentId: image.documentId,
          canonicalKey: image.canonicalKey,
          pageId: image.pageId,
        },
      },
      create: image,
      update: {},
    });
  }
  async cached(
    documentId: string,
    imageHash: string,
    provider: OcrProviderId,
    settingsHash: string,
  ): Promise<OcrPageRecord | null> {
    const row = await this.prisma.ocrPageResult.findFirst({
      where: {
        run: { documentId },
        imageHash,
        provider,
        settingsHash,
        status: 'DONE',
        resultKey: { not: null },
      },
      orderBy: { completedAt: 'desc' },
    });
    return row === null ? null : pageOf(row);
  }
}
