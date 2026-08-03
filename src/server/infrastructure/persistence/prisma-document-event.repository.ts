import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { DocumentEventPayload } from '../../domain/entities/document-event';
import {
  DocumentEventRepository,
  type DocumentEventView,
  type NewDocumentEvent,
} from '../../domain/repositories/document-event.repository';
import { decodeCursor, encodeCursor } from './cursor';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

// The payload is written by us and read back by us, but it has been in a database in between: a
// shape this version does not know is dropped rather than crashing a log page.
const payloadSchema = z
  .object({
    step: z.string().optional(),
    status: z.string().optional(),
    reason: z.string().optional(),
    error: z.string().optional(),
    steps: z.array(z.string()).optional(),
    source: z.string().optional(),
    library: z.string().optional(),
    path: z.string().optional(),
    changes: z
      .record(z.object({ from: z.string().nullish(), to: z.string().nullish() }))
      .optional(),
  })
  .catch({});

@Injectable()
export class PrismaDocumentEventRepository extends DocumentEventRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async record(event: NewDocumentEvent, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).documentEvent.create({
      data: {
        documentId: event.documentId,
        type: event.type,
        actorId: event.actorId ?? null,
        payload: event.payload ?? {},
      },
    });
  }

  async listForDocument(
    documentId: string,
    query: { limit: number; cursor?: string | undefined },
    tx?: TransactionHandle,
  ): Promise<{ items: DocumentEventView[]; nextCursor: string | null }> {
    const cursor = decodeCursor(query.cursor);
    const rows = await clientOf(this.prisma, tx).documentEvent.findMany({
      where: {
        documentId,
        // Keyset pagination on (at, id): a timestamp alone collides, and several events of one run
        // share a millisecond (docs/07 §7.1).
        ...(cursor === null
          ? {}
          : {
              OR: [{ at: { lt: cursor.at } }, { at: cursor.at, id: { lt: cursor.id } }],
            }),
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: { actor: { select: { displayName: true } } },
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        documentId: row.documentId,
        type: row.type,
        actorId: row.actorId,
        payload: toPayload(row.payload),
        at: row.at,
        actorName: row.actor?.displayName ?? null,
      })),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ at: last.at, id: last.id })
          : null,
    };
  }
}

function toPayload(value: unknown): DocumentEventPayload {
  return payloadSchema.parse(value);
}
