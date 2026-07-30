import { Injectable } from '@nestjs/common';
import { Prisma, type Document as PrismaDocument } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Document } from '../../domain/entities/document';
import {
  DocumentRepository,
  type CreateDocumentInput,
  type DocumentUpsert,
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

@Injectable()
export class PrismaDocumentRepository implements DocumentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: TransactionHandle): Promise<Document | null> {
    const row = await clientOf(this.prisma, tx).document.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
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
