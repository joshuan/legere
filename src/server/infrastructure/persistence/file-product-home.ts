import { Prisma } from '@prisma/client';
import { ConflictError } from '../../domain/errors/domain-error';
import type { PrismaTx } from './prisma-unit-of-work';

// Both product writers lock the same file rows in conflicting modes before checking ownership.
// Without these locks a document append and receipt creation can both see an unclaimed original.
async function lockFiles(
  client: PrismaTx,
  fileIds: readonly string[],
  kind: 'DOCUMENT' | 'RECEIPT',
): Promise<void> {
  if (fileIds.length === 0) return;
  // Document readers share the same lock their page foreign keys take. Only a receipt claim
  // needs to exclude them; ordinary document edits and file metadata updates stay compatible.
  const lock =
    kind === 'DOCUMENT'
      ? Prisma.sql`FOR KEY SHARE SKIP LOCKED`
      : Prisma.sql`FOR UPDATE SKIP LOCKED`;
  const locked = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM files WHERE id IN (${Prisma.join(fileIds.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY id ${lock}
  `);
  // Multi-document edits can already hold another document's lock. Waiting for a shared file
  // here would invert that order against a split or conversion; refuse the whole edit instead.
  if (locked.length !== fileIds.length) {
    throw new ConflictError('DOCUMENT_CHANGED', 'The original is being changed; try again');
  }
}

export async function assertDocumentFiles(
  client: PrismaTx,
  fileIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(fileIds)].sort();
  if (ids.length === 0) return;
  await lockFiles(client, ids, 'DOCUMENT');
  const receipt = await client.receipt.findFirst({
    where: { fileId: { in: ids } },
    select: { id: true },
  });
  if (receipt !== null) {
    throw new ConflictError('RECEIPT_DUPLICATE', 'This content already belongs to a receipt');
  }
}

export async function assertReceiptFile(client: PrismaTx, fileId: string): Promise<void> {
  await lockFiles(client, [fileId], 'RECEIPT');
  const file = await client.file.findUnique({ where: { id: fileId } });
  if (file === null || file.origin !== 'MANAGED' || file.storageKey === null) {
    throw new ConflictError('ARCHIVE_KIND_CONFLICT', 'A receipt requires a managed original');
  }
  const page = await client.documentPage.findFirst({
    where: { fileId, document: { deletedAt: null } },
    select: { id: true },
  });
  if (page !== null) {
    throw new ConflictError('RECEIPT_DUPLICATE', 'This content already belongs to a document');
  }
  const receipt = await client.receipt.findUnique({ where: { fileId }, select: { id: true } });
  if (receipt !== null) {
    throw new ConflictError('RECEIPT_DUPLICATE', 'This content already belongs to a receipt');
  }
}
