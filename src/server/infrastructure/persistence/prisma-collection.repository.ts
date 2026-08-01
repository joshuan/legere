import { Injectable } from '@nestjs/common';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import {
  CollectionRepository,
  type Collection,
  type CollectionShare,
  type CollectionSummary,
  type CreateCollectionInput,
  type UpdateCollectionInput,
} from '../../domain/repositories/collection.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

type CollectionRow = {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  owner: { displayName: string };
};

function toDomain(row: CollectionRow): Collection {
  return {
    id: row.id,
    ownerId: row.ownerId,
    ownerName: row.owner.displayName,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

type ShareRow = {
  id: string;
  collectionId: string;
  granteeUserId: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  grantee: { displayName: string } | null;
};

function toShare(row: ShareRow): CollectionShare {
  return {
    id: row.id,
    collectionId: row.collectionId,
    granteeUserId: row.granteeUserId,
    granteeName: row.grantee?.displayName ?? null,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

const OWNER = { select: { displayName: true } } as const;

@Injectable()
export class PrismaCollectionRepository implements CollectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string, tx?: TransactionHandle): Promise<CollectionSummary[]> {
    const rows = await clientOf(this.prisma, tx).collection.findMany({
      where: {
        deletedAt: null,
        OR: [
          { ownerId: userId },
          // An instance-wide share (granteeUserId null) reaches everyone but the owner's own list
          // already covers them (docs/03 §3.3.15).
          {
            shares: {
              some: { revokedAt: null, OR: [{ granteeUserId: userId }, { granteeUserId: null }] },
            },
          },
        ],
      },
      include: {
        owner: OWNER,
        shares: { where: { revokedAt: null }, select: { granteeUserId: true } },
        _count: { select: { items: true } },
      },
      orderBy: { name: 'asc' },
    });

    return rows.map((row) => ({
      ...toDomain(row),
      itemCount: row._count.items,
      sharedByMe: row.ownerId === userId && row.shares.length > 0,
      sharedWithMe: row.ownerId !== userId,
    }));
  }

  async findById(id: string, tx?: TransactionHandle): Promise<Collection | null> {
    const row = await clientOf(this.prisma, tx).collection.findFirst({
      where: { id, deletedAt: null },
      include: { owner: OWNER },
    });
    return row === null ? null : toDomain(row);
  }

  async isReadableBy(id: string, userId: string, tx?: TransactionHandle): Promise<boolean> {
    const count = await clientOf(this.prisma, tx).collection.count({
      where: {
        id,
        deletedAt: null,
        OR: [
          { ownerId: userId },
          {
            shares: {
              some: { revokedAt: null, OR: [{ granteeUserId: userId }, { granteeUserId: null }] },
            },
          },
        ],
      },
    });
    return count > 0;
  }

  async findByOwnerAndName(
    ownerId: string,
    name: string,
    tx?: TransactionHandle,
  ): Promise<Collection | null> {
    const row = await clientOf(this.prisma, tx).collection.findFirst({
      where: { ownerId, name, deletedAt: null },
      include: { owner: OWNER },
    });
    return row === null ? null : toDomain(row);
  }

  async create(input: CreateCollectionInput, tx?: TransactionHandle): Promise<Collection> {
    const row = await clientOf(this.prisma, tx).collection.create({
      data: { ownerId: input.ownerId, name: input.name, description: input.description },
      include: { owner: OWNER },
    });
    return toDomain(row);
  }

  async update(
    id: string,
    input: UpdateCollectionInput,
    tx?: TransactionHandle,
  ): Promise<Collection> {
    const row = await clientOf(this.prisma, tx).collection.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      include: { owner: OWNER },
    });
    return toDomain(row);
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).collection.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt },
    });
  }

  async addItem(
    collectionId: string,
    documentId: string,
    addedById: string,
    tx?: TransactionHandle,
  ): Promise<void> {
    // Adding the same document twice is not an error: the collection already says what the user
    // wanted it to say.
    await clientOf(this.prisma, tx).collectionItem.upsert({
      where: { collectionId_documentId: { collectionId, documentId } },
      create: { collectionId, documentId, addedById },
      update: {},
    });
  }

  async removeItem(
    collectionId: string,
    documentId: string,
    tx?: TransactionHandle,
  ): Promise<void> {
    await clientOf(this.prisma, tx).collectionItem.deleteMany({
      where: { collectionId, documentId },
    });
  }

  async listActiveShares(collectionId: string, tx?: TransactionHandle): Promise<CollectionShare[]> {
    const rows = await clientOf(this.prisma, tx).collectionShare.findMany({
      where: { collectionId, revokedAt: null },
      include: { grantee: { select: { displayName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toShare);
  }

  async findActiveShare(
    collectionId: string,
    granteeUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<CollectionShare | null> {
    const row = await clientOf(this.prisma, tx).collectionShare.findFirst({
      where: { collectionId, granteeUserId, revokedAt: null },
      include: { grantee: { select: { displayName: true } } },
    });
    return row === null ? null : toShare(row);
  }

  async createShare(
    collectionId: string,
    granteeUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<CollectionShare> {
    const row = await clientOf(this.prisma, tx).collectionShare.create({
      data: { collectionId, granteeUserId },
      include: { grantee: { select: { displayName: true } } },
    });
    return toShare(row);
  }

  // Revoking leaves the row: who was given access and when is worth keeping (docs/03 §3.3.15).
  async revokeShare(shareId: string, revokedAt: Date, tx?: TransactionHandle): Promise<boolean> {
    const result = await clientOf(this.prisma, tx).collectionShare.updateMany({
      where: { id: shareId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count > 0;
  }
}
