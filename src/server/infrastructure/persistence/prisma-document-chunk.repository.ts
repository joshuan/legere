import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import {
  DocumentChunkRepository,
  type NewDocumentChunk,
} from '../../domain/repositories/document-chunk.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaDocumentChunkRepository implements DocumentChunkRepository {
  constructor(private readonly prisma: PrismaService) {}

  async replaceForDocument(
    documentId: string,
    chunks: readonly NewDocumentChunk[],
    tx?: TransactionHandle,
  ): Promise<void> {
    const client = clientOf(this.prisma, tx);

    // Wholesale replacement (docs/03 §3.3.11): the old set goes first, so a document that now
    // yields fewer chunks does not keep the tail of its previous vectorization.
    await client.documentChunk.deleteMany({ where: { documentId } });
    if (chunks.length === 0) return;

    // `embedding` is a pgvector column, which Prisma cannot model (docs/04 §4.4), so the insert is
    // raw — one statement for the whole set, with every value still bound rather than interpolated.
    const rows = chunks.map(
      (chunk) => Prisma.sql`(
        gen_random_uuid(),
        ${documentId}::uuid,
        ${chunk.index},
        ${chunk.content},
        ${chunk.charCount},
        ${toVectorLiteral(chunk.embedding)}::vector,
        ${chunk.model}
      )`,
    );

    await client.$executeRaw(
      Prisma.sql`INSERT INTO document_chunks (id, document_id, "index", content, char_count, embedding, model)
        VALUES ${Prisma.join(rows)}`,
    );
  }

  countForDocument(documentId: string, tx?: TransactionHandle): Promise<number> {
    return clientOf(this.prisma, tx).documentChunk.count({ where: { documentId } });
  }

  // One grouped count for the panel that owns the pipeline (docs/07 §7.3): more than one row here is
  // a model switch that has not finished, and that is the one state where a cosine distance between
  // two chunks means nothing at all (docs/04 §4.5).
  async countByModel(
    tx?: TransactionHandle,
  ): Promise<Array<{ model: string | null; chunks: number }>> {
    const rows = await clientOf(this.prisma, tx).documentChunk.groupBy({
      by: ['model'],
      _count: { _all: true },
    });
    return rows
      .map((row) => ({ model: row.model, chunks: row._count._all }))
      .sort((a, b) => b.chunks - a.chunks || (a.model ?? '').localeCompare(b.model ?? ''));
  }
}

// pgvector's text input format: [0.1,0.2,…]. A NaN or Infinity would pass as text and be refused by
// the type, mid-insert; catching it here makes the message say what actually went wrong.
function toVectorLiteral(embedding: readonly number[]): string {
  for (const value of embedding) {
    if (!Number.isFinite(value)) throw new Error('Embedding contains a non-finite value');
  }
  return `[${embedding.join(',')}]`;
}
