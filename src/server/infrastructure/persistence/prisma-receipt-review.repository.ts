import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  receiptDuplicatePairSchema,
  receiptReviewActionSchema,
} from '../../../shared/contracts/receipt-duplicates';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Viewer } from '../../domain/repositories/document.repository';
import {
  ReceiptReviewRepository,
  type NewReceiptReview,
  type ReceiptReview,
} from '../../domain/repositories/receipt-review.repository';
import { decodeTextCursor, encodeTextCursor } from './cursor';
import { ConflictError } from '../../domain/errors/domain-error';
import { clientOf } from './prisma-client';
import { RECEIPT_INCLUDE, toDomain } from './prisma-receipt.repository';
import { PrismaService } from './prisma.service';

const REVIEW_INCLUDE = {
  actor: { select: { id: true, displayName: true } },
} satisfies Prisma.ReceiptReviewInclude;
const CANDIDATE_BATCH = 200;
type ReviewRow = Prisma.ReceiptReviewGetPayload<{ include: typeof REVIEW_INCLUDE }>;
function reviewOf(row: ReviewRow): ReceiptReview {
  return {
    ...row,
    pair: receiptDuplicatePairSchema.parse(row.pair),
    action: receiptReviewActionSchema.parse(row.action),
  };
}
function scope(viewer: Viewer): Prisma.ReceiptReviewWhereInput {
  return viewer.role === 'ADMIN' ? {} : { ownerId: viewer.id };
}

@Injectable()
export class PrismaReceiptReviewRepository extends ReceiptReviewRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async candidates(viewer: Viewer, cursor?: string) {
    const decoded = decodeTextCursor(cursor);
    const after =
      decoded !== null && z.string().uuid().safeParse(decoded.key).success ? decoded : null;
    const rows = await this.prisma.$queryRaw<
      Array<{
        firstId: string;
        secondId: string;
        reviewedRevision: string | null;
      }>
    >(Prisma.sql`
      SELECT l.id AS "firstId", r.id AS "secondId",
        CASE WHEN decision.undone_at IS NULL THEN decision.revision ELSE NULL END AS "reviewedRevision"
      FROM receipts l
      JOIN archive_items a ON a.id = l.id AND a.deleted_at IS NULL
      JOIN receipts r ON r.id > l.id AND r.purchased_at = l.purchased_at
        AND r.currency = l.currency AND r.total_amount = l.total_amount
      JOIN archive_items b ON b.id = r.id AND b.deleted_at IS NULL AND b.created_by_id = a.created_by_id
      LEFT JOIN LATERAL (
        SELECT revision, undone_at FROM receipt_reviews
        WHERE first_id = l.id AND second_id = r.id
        ORDER BY position DESC LIMIT 1
      ) decision ON TRUE
      WHERE l.preview_status = 'DONE' AND r.preview_status = 'DONE'
        AND l.review_state = 'ACTIVE' AND r.review_state = 'ACTIVE'
        AND l.extraction_status = 'DONE' AND r.extraction_status = 'DONE'
        AND l.extracted IS NOT NULL AND r.extracted IS NOT NULL
        AND ${viewer.role === 'ADMIN' ? Prisma.sql`TRUE` : Prisma.sql`a.created_by_id = ${viewer.id}::uuid`}
        AND ${after === null ? Prisma.sql`TRUE` : Prisma.sql`(l.id, r.id) > (${after.key}::uuid, ${after.id}::uuid)`}
      ORDER BY l.id, r.id LIMIT ${CANDIDATE_BATCH + 1}
    `);
    const page = rows.slice(0, CANDIDATE_BATCH);
    const ids = [...new Set(page.flatMap((pair) => [pair.firstId, pair.secondId]))];
    const receipts = await this.prisma.receipt.findMany({
      where: {
        id: { in: ids },
        reviewState: 'ACTIVE',
        archiveItem: {
          deletedAt: null,
          ...(viewer.role === 'ADMIN' ? {} : { createdById: viewer.id }),
        },
      },
      include: RECEIPT_INCLUDE,
    });
    const byId = new Map(receipts.map((row) => [row.id, toDomain(row)]));
    const last = page.at(-1);
    return {
      pairs: page.flatMap((pair) => {
        const first = byId.get(pair.firstId);
        const second = byId.get(pair.secondId);
        return first === undefined || second === undefined
          ? []
          : [{ first, second, reviewedRevision: pair.reviewedRevision }];
      }),
      nextCursor:
        rows.length > CANDIDATE_BATCH && last !== undefined
          ? encodeTextCursor({ key: last.firstId, id: last.secondId })
          : null,
    };
  }

  async latest(
    firstId: string,
    secondId: string,
    tx: TransactionHandle,
  ): Promise<ReceiptReview | null> {
    const row = await clientOf(this.prisma, tx).receiptReview.findFirst({
      where: { firstId, secondId },
      orderBy: { position: 'desc' },
      include: REVIEW_INCLUDE,
    });
    return row === null ? null : reviewOf(row);
  }

  async find(id: string, viewer: Viewer, tx?: TransactionHandle): Promise<ReceiptReview | null> {
    const row = await clientOf(this.prisma, tx).receiptReview.findFirst({
      where: { id, ...scope(viewer) },
      include: REVIEW_INCLUDE,
    });
    return row === null ? null : reviewOf(row);
  }

  async list(viewer: Viewer, query: { limit: number; cursor?: string | undefined }) {
    const after = decodeTextCursor(query.cursor);
    const parsed = after !== null && /^\d{1,19}$/.test(after.key) ? BigInt(after.key) : null;
    const position = parsed !== null && parsed <= 9223372036854775807n ? parsed : null;
    const rows = await this.prisma.receiptReview.findMany({
      where: { ...scope(viewer), ...(position === null ? {} : { position: { lt: position } }) },
      orderBy: { position: 'desc' },
      take: query.limit + 1,
      include: REVIEW_INCLUDE,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(reviewOf),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeTextCursor({ key: last.position.toString(), id: last.id })
          : null,
    };
  }

  async create(input: NewReceiptReview, tx: TransactionHandle): Promise<ReceiptReview> {
    try {
      return reviewOf(
        await clientOf(this.prisma, tx).receiptReview.create({
          data: { ...input, pair: { toJSON: () => input.pair } },
          include: REVIEW_INCLUDE,
        }),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('RECEIPT_CHANGED', 'This operation id has already been used');
      }
      throw error;
    }
  }

  async undo(id: string, at: Date, tx: TransactionHandle): Promise<ReceiptReview> {
    return reviewOf(
      await clientOf(this.prisma, tx).receiptReview.update({
        where: { id },
        data: { undoneAt: at },
        include: REVIEW_INCLUDE,
      }),
    );
  }

  async hasDependents(
    receiptIds: string[],
    exceptId: string,
    tx: TransactionHandle,
  ): Promise<boolean> {
    const anchor = await clientOf(this.prisma, tx).receiptReview.findUniqueOrThrow({
      where: { id: exceptId },
      select: { position: true },
    });
    return (
      (await clientOf(this.prisma, tx).receiptReview.findFirst({
        where: {
          position: { gt: anchor.position },
          undoneAt: null,
          action: { not: 'DISMISS' },
          OR: [{ firstId: { in: receiptIds } }, { secondId: { in: receiptIds } }],
        },
        select: { id: true },
      })) !== null
    );
  }

  async reusableResult(
    resultId: string,
    firstId: string,
    secondId: string,
    tx: TransactionHandle,
  ): Promise<boolean> {
    return (
      (await clientOf(this.prisma, tx).receiptReview.findFirst({
        where: { resultId, firstId, secondId, action: 'MERGE', undoneAt: { not: null } },
        select: { id: true },
      })) !== null
    );
  }
}
