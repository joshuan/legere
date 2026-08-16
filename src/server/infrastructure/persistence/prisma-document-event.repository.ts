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
    service: z.string().optional(),
    endpoint: z.string().optional(),
    requestId: z.string().optional(),
    // What the step cost and what it produced (docs/03 §3.3.18). These were written and then
    // stripped right here on the way back out, so the log answered "how long did this take" with
    // silence — the schema is the one place "known shape" is decided, and it had fallen behind
    // the writer.
    durationMs: z.number().optional(),
    chars: z.number().optional(),
    pages: z.number().optional(),
    ocrUsed: z.boolean().optional(),
    promptTokens: z.number().optional(),
    completionTokens: z.number().optional(),
    transcribed: z.boolean().optional(),
    // What the step made of its own work (docs/03 §3.3.18) — written here, so it has to be a known
    // shape here too, or the journal would forget it on the way back out.
    legibility: z.number().optional(),
    extraction: z.number().optional(),
    confidence: z.number().optional(),
    source: z.string().optional(),
    library: z.string().optional(),
    path: z.string().optional(),
    // The other end of a link, as a record (docs/03 §3.3.23).
    otherDocumentId: z.string().optional(),
    otherTitle: z.string().optional(),
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
    const client = clientOf(this.prisma, tx);
    const row = await client.documentEvent.create({
      data: {
        documentId: event.documentId,
        type: event.type,
        actorId: event.actorId ?? null,
        payload: event.payload ?? {},
      },
    });

    // "When did this document last change" is the newest entry in this log (docs/03 §3.3.18), and
    // ranking an archive by an aggregate over it is not something an index can serve — so the answer
    // is kept beside the document and written here, at the one write site every event goes through.
    // A log nothing is missing from is exactly what makes the column trustworthy.
    //
    // `GREATEST` rather than an assignment: two entries of the same run can be written out of the
    // order they happened in, and the newest must not be undone by a straggler. Raw rather than the
    // typed client on purpose — `updated_at` is not touched, because this is not an edit of the
    // document, and because `updated_at` is the very column this one exists to stop standing in for.
    await client.$executeRaw`
      UPDATE documents
         SET last_event_at = GREATEST(last_event_at, ${row.at}::timestamptz)
       WHERE id = ${event.documentId}::uuid`;
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
