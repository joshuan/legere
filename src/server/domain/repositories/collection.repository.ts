import type { TransactionHandle } from '../../application/ports/unit-of-work';

// Collection entities (docs/03 §3.3.13–3.3.15).
export type Collection = {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  description: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

export type CollectionShare = {
  id: string;
  collectionId: string;
  // null = the whole instance.
  granteeUserId: string | null;
  granteeName: string | null;
  createdAt: Date;
  revokedAt: Date | null;
};

export type CollectionSummary = Collection & {
  itemCount: number;
  sharedByMe: boolean;
  sharedWithMe: boolean;
};

export type CreateCollectionInput = {
  ownerId: string;
  name: string;
  description: string | null;
};

export type UpdateCollectionInput = {
  name?: string;
  description?: string | null;
};

export abstract class CollectionRepository {
  // Own collections plus the ones shared with the caller (docs/07 §7.3), by name.
  abstract listForUser(userId: string, tx?: TransactionHandle): Promise<CollectionSummary[]>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<Collection | null>;

  // Whether this user may read the collection at all: owner, admin, or an active share
  // (docs/03 §3.4).
  abstract isReadableBy(id: string, userId: string, tx?: TransactionHandle): Promise<boolean>;

  abstract findByOwnerAndName(
    ownerId: string,
    name: string,
    tx?: TransactionHandle,
  ): Promise<Collection | null>;

  abstract create(input: CreateCollectionInput, tx?: TransactionHandle): Promise<Collection>;

  abstract update(
    id: string,
    input: UpdateCollectionInput,
    tx?: TransactionHandle,
  ): Promise<Collection>;

  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

  // Items are hard-deleted on removal (docs/03 §3.3.14): a collection is a view, not a record of
  // what was once in it.
  abstract addItem(
    collectionId: string,
    documentId: string,
    addedById: string,
    tx?: TransactionHandle,
  ): Promise<void>;

  abstract removeItem(
    collectionId: string,
    documentId: string,
    tx?: TransactionHandle,
  ): Promise<void>;

  abstract listActiveShares(
    collectionId: string,
    tx?: TransactionHandle,
  ): Promise<CollectionShare[]>;

  abstract findActiveShare(
    collectionId: string,
    granteeUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<CollectionShare | null>;

  abstract createShare(
    collectionId: string,
    granteeUserId: string | null,
    tx?: TransactionHandle,
  ): Promise<CollectionShare>;

  abstract revokeShare(shareId: string, revokedAt: Date, tx?: TransactionHandle): Promise<boolean>;
}
