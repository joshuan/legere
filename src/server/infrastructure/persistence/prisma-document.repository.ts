import { Injectable } from '@nestjs/common';
import { Prisma, type Document as PrismaDocument } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Document } from '../../domain/entities/document';
import type { DocumentStep } from '../../../shared/contracts/documents';
import { stepStatusSchema, type StepStatus } from '../../../shared/contracts/enums';
import {
  DocumentRepository,
  type CreateDocumentInput,
  type DocumentUpsert,
  type ProcessingUpdate,
  type StepStatusCounters,
} from '../../domain/repositories/document.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaDocument): Document {
  return {
    id: row.id,
    contentHash: row.contentHash,
    source: row.source,
    mimeType: row.mimeType,
    ext: row.ext,
    sizeBytes: row.sizeBytes,
    pageCount: row.pageCount,
    title: row.title,
    markdown: row.markdown,
    steps: {
      canonical: row.canonicalStatus,
      preview: row.previewStatus,
      markdown: row.markdownStatus,
      categorization: row.categorizationStatus,
      vectorization: row.vectorizationStatus,
    },
    processingError: row.processingError,
    failedStep: row.failedStep,
    ocrUsed: row.ocrUsed,
    categoryId: row.categoryId,
    categorySource: row.categorySource,
    createdById: row.createdById,
    scanSetId: row.scanSetId,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

// processingError is capped at 2000 characters (docs/03 §3.3.10): a stack trace or an HTML error page
// from a sibling container must not become the largest column in the table.
const MAX_ERROR_CHARS = 2000;

function truncate(message: string | null): string | null {
  if (message === null) return null;
  return message.length <= MAX_ERROR_CHARS ? message : `${message.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

type CounterRow = {
  canonical_status: string;
  preview_status: string;
  markdown_status: string;
  categorization_status: string;
  vectorization_status: string;
  count: bigint;
};

function emptyCounters(): StepStatusCounters {
  const zeroes = (): Record<StepStatus, number> => ({
    PENDING: 0,
    DONE: 0,
    FAILED: 0,
    SKIPPED: 0,
  });
  // Written out rather than derived: a type assertion is forbidden here (docs/14 §14.1), and the
  // compiler should be the one checking that every step is present.
  return {
    total: 0,
    steps: {
      canonical: zeroes(),
      preview: zeroes(),
      markdown: zeroes(),
      categorization: zeroes(),
      vectorization: zeroes(),
    },
  };
}

function add(
  counters: StepStatusCounters,
  step: DocumentStep,
  status: string,
  count: number,
): void {
  const parsed = stepStatusSchema.safeParse(status);
  if (!parsed.success) return;
  counters.steps[step][parsed.data] += count;
}

@Injectable()
export class PrismaDocumentRepository implements DocumentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: TransactionHandle): Promise<Document | null> {
    const row = await clientOf(this.prisma, tx).document.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async updateProcessing(
    id: string,
    update: ProcessingUpdate,
    tx?: TransactionHandle,
  ): Promise<Document> {
    const steps = update.steps ?? {};
    const row = await clientOf(this.prisma, tx).document.update({
      where: { id },
      data: {
        ...(steps.canonical === undefined ? {} : { canonicalStatus: steps.canonical }),
        ...(steps.preview === undefined ? {} : { previewStatus: steps.preview }),
        ...(steps.markdown === undefined ? {} : { markdownStatus: steps.markdown }),
        ...(steps.categorization === undefined
          ? {}
          : { categorizationStatus: steps.categorization }),
        ...(steps.vectorization === undefined ? {} : { vectorizationStatus: steps.vectorization }),
        ...(update.pageCount === undefined ? {} : { pageCount: update.pageCount }),
        ...(update.markdown === undefined ? {} : { markdown: update.markdown }),
        ...(update.ocrUsed === undefined ? {} : { ocrUsed: update.ocrUsed }),
        ...(update.processingError === undefined
          ? {}
          : { processingError: truncate(update.processingError) }),
        ...(update.failedStep === undefined ? {} : { failedStep: update.failedStep }),
        ...(update.categoryId === undefined ? {} : { categoryId: update.categoryId }),
        ...(update.categorySource === undefined ? {} : { categorySource: update.categorySource }),
      },
    });
    return toDomain(row);
  }

  // One pass over the table rather than twenty count queries: every step column is aggregated in
  // the same scan (docs/05 §5.8).
  async countByStepStatus(tx?: TransactionHandle): Promise<StepStatusCounters> {
    const rows = await clientOf(this.prisma, tx).$queryRaw<CounterRow[]>`
      SELECT canonical_status, preview_status, markdown_status,
             categorization_status, vectorization_status, count(*) AS count
      FROM documents
      WHERE deleted_at IS NULL
      GROUP BY 1, 2, 3, 4, 5
    `;

    const counters = emptyCounters();
    for (const row of rows) {
      const count = Number(row.count);
      counters.total += count;
      add(counters, 'canonical', row.canonical_status, count);
      add(counters, 'preview', row.preview_status, count);
      add(counters, 'markdown', row.markdown_status, count);
      add(counters, 'categorization', row.categorization_status, count);
      add(counters, 'vectorization', row.vectorization_status, count);
    }
    return counters;
  }

  async findActiveByContentHash(
    contentHash: string,
    tx?: TransactionHandle,
  ): Promise<Document | null> {
    const row = await clientOf(this.prisma, tx).document.findFirst({
      where: { contentHash, deletedAt: null },
    });
    return row === null ? null : toDomain(row);
  }

  async findOrCreateByContentHash(
    input: CreateDocumentInput,
    tx?: TransactionHandle,
  ): Promise<DocumentUpsert> {
    const existing = await this.findActiveByContentHash(input.contentHash, tx);
    if (existing !== null) return { document: existing, created: false };

    try {
      const row = await clientOf(this.prisma, tx).document.create({
        data: {
          contentHash: input.contentHash,
          source: input.source,
          mimeType: input.mimeType,
          ext: input.ext,
          sizeBytes: input.sizeBytes,
          title: input.title,
          createdById: input.createdById ?? null,
          scanSetId: input.scanSetId ?? null,
        },
      });
      return { document: toDomain(row), created: true };
    } catch (error) {
      // documents_content_hash_active_uq (docs/04 §4.3): another ingest inserted the same content
      // between the read above and this write. Whoever lost simply attaches to the winner, so
      // identical content still yields exactly one document.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findActiveByContentHash(input.contentHash, tx);
        if (winner !== null) return { document: winner, created: false };
      }
      throw error;
    }
  }
}
