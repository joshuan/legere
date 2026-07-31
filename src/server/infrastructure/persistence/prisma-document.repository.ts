import { Injectable } from '@nestjs/common';
import { Prisma, type Document as PrismaDocument } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Document } from '../../domain/entities/document';
import {
  DocumentRepository,
  type CreateDocumentInput,
  type DocumentUpsert,
  type ProcessingUpdate,
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
      },
    });
    return toDomain(row);
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
