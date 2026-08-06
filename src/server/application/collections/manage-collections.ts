import type {
  AddCollectionItemRequest,
  CollectionDetailResponse,
  CollectionDto,
  CollectionItemsQuery,
  CreateCollectionRequest,
  CreateShareRequest,
  ListCollectionSharesResponse,
  ListCollectionsResponse,
  UpdateCollectionRequest,
} from '../../../shared/contracts/collections';
import { ConflictError, ForbiddenError, NotFoundError } from '../../domain/errors/domain-error';
import type {
  Collection,
  CollectionRepository,
  CollectionSummary,
} from '../../domain/repositories/collection.repository';
import type { DocumentRepository, Viewer } from '../../domain/repositories/document.repository';
import type { UserRepository } from '../../domain/repositories/user.repository';
import { toListDto } from '../documents/manage-documents';
import type { Clock } from '../ports/clock';

// Managing a collection is the owner's business; an admin can do it too, for maintenance
// (docs/03 §3.4).
//
// The two failures are deliberately different. A collection the caller cannot even read answers
// 404 — its existence is not theirs to know. One they can read but not manage answers 403: they
// already know it exists, and the honest answer is that it is not theirs (docs/08 §8.5).
async function requireManageable(
  collections: CollectionRepository,
  viewer: Viewer,
  id: string,
): Promise<Collection> {
  const collection = await collections.findById(id);
  if (collection === null) throw new NotFoundError('COLLECTION_NOT_FOUND', 'Collection not found');

  if (viewer.role === 'ADMIN' || collection.ownerId === viewer.id) return collection;
  if (await collections.isReadableBy(id, viewer.id)) {
    throw new ForbiddenError('This collection belongs to someone else');
  }
  throw new NotFoundError('COLLECTION_NOT_FOUND', 'Collection not found');
}

export class ListCollections {
  constructor(private readonly collections: CollectionRepository) {}

  async execute(viewer: Viewer): Promise<ListCollectionsResponse> {
    const rows = await this.collections.listForUser(viewer.id);
    return { items: rows.map((row) => toDto(row, viewer)) };
  }
}

export class CreateCollection {
  constructor(private readonly collections: CollectionRepository) {}

  async execute(viewer: Viewer, input: CreateCollectionRequest): Promise<CollectionDto> {
    // Unique per owner, not globally: two people may each have a "Taxes" (docs/03 §3.3.13).
    const existing = await this.collections.findByOwnerAndName(viewer.id, input.name);
    if (existing !== null) {
      throw new ConflictError(
        'COLLECTION_NAME_TAKEN',
        'You already have a collection with this name',
      );
    }

    const created = await this.collections.create({
      ownerId: viewer.id,
      name: input.name,
      description: input.description ?? null,
    });
    return toDto({ ...created, itemCount: 0, sharedByMe: false, sharedWithMe: false }, viewer);
  }
}

export class GetCollection {
  constructor(
    private readonly collections: CollectionRepository,
    private readonly documents: DocumentRepository,
  ) {}

  async execute(
    viewer: Viewer,
    id: string,
    query: CollectionItemsQuery,
  ): Promise<CollectionDetailResponse> {
    const collection = await this.requireReadable(viewer, id);
    // 🔒 Each viewer sees the intersection of the collection and their own access (docs/03 §3.3.14)
    // — the owner's access grants nothing to anyone else.
    const items = await this.documents.listInCollection(id, viewer, query);

    return {
      collection: toDto(collection, viewer),
      items: { items: items.items.map(toListDto), nextCursor: items.nextCursor },
    };
  }

  private async requireReadable(viewer: Viewer, id: string): Promise<CollectionSummary> {
    const collection = await this.collections.findById(id);
    if (collection === null) {
      throw new NotFoundError('COLLECTION_NOT_FOUND', 'Collection not found');
    }
    if (viewer.role !== 'ADMIN' && !(await this.collections.isReadableBy(id, viewer.id))) {
      throw new NotFoundError('COLLECTION_NOT_FOUND', 'Collection not found');
    }

    const summaries = await this.collections.listForUser(viewer.id);
    const summary = summaries.find((candidate) => candidate.id === id);
    return summary ?? { ...collection, itemCount: 0, sharedByMe: false, sharedWithMe: false };
  }
}

export class UpdateCollection {
  constructor(private readonly collections: CollectionRepository) {}

  async execute(
    viewer: Viewer,
    id: string,
    input: UpdateCollectionRequest,
  ): Promise<CollectionDto> {
    const collection = await requireManageable(this.collections, viewer, id);

    if (input.name !== undefined && input.name !== collection.name) {
      const clash = await this.collections.findByOwnerAndName(collection.ownerId, input.name);
      if (clash !== null) {
        throw new ConflictError('COLLECTION_NAME_TAKEN', 'A collection with this name exists');
      }
    }

    const updated = await this.collections.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    return toDto({ ...updated, itemCount: 0, sharedByMe: false, sharedWithMe: false }, viewer);
  }
}

export class DeleteCollection {
  constructor(
    private readonly collections: CollectionRepository,
    private readonly clock: Clock,
  ) {}

  async execute(viewer: Viewer, id: string): Promise<{ ok: true }> {
    await requireManageable(this.collections, viewer, id);

    await this.collections.softDelete(id, this.clock.now());
    return { ok: true };
  }
}

export class AddCollectionItem {
  constructor(
    private readonly collections: CollectionRepository,
    private readonly documents: DocumentRepository,
  ) {}

  async execute(
    viewer: Viewer,
    id: string,
    input: AddCollectionItemRequest,
  ): Promise<{ ok: true }> {
    await requireManageable(this.collections, viewer, id);

    // 🔒 A document can only be added by someone who can read it at that moment (docs/03 §3.3.14) —
    // otherwise a collection would be a way to launder access to a document you cannot open.
    const document = await this.documents.findReadableById(input.documentId, viewer);
    if (document === null) throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');

    await this.collections.addItem(id, input.documentId, viewer.id);
    return { ok: true };
  }
}

export class RemoveCollectionItem {
  constructor(private readonly collections: CollectionRepository) {}

  async execute(viewer: Viewer, id: string, documentId: string): Promise<{ ok: true }> {
    await requireManageable(this.collections, viewer, id);

    await this.collections.removeItem(id, documentId);
    return { ok: true };
  }
}

export class ListCollectionShares {
  constructor(private readonly collections: CollectionRepository) {}

  async execute(viewer: Viewer, id: string): Promise<ListCollectionSharesResponse> {
    await requireManageable(this.collections, viewer, id);

    const shares = await this.collections.listActiveShares(id);
    return {
      items: shares.map((share) => ({
        id: share.id,
        granteeUserId: share.granteeUserId,
        granteeName: share.granteeName,
        createdAt: share.createdAt.toISOString(),
      })),
    };
  }
}

export class ShareCollection {
  constructor(
    private readonly collections: CollectionRepository,
    private readonly users: UserRepository,
  ) {}

  async execute(
    viewer: Viewer,
    id: string,
    input: CreateShareRequest,
  ): Promise<{
    id: string;
    granteeUserId: string | null;
    granteeName: string | null;
    createdAt: string;
  }> {
    await requireManageable(this.collections, viewer, id);

    if (input.granteeUserId !== null) {
      const grantee = await this.users.findById(input.granteeUserId);
      if (grantee === null || grantee.deactivatedAt !== null) {
        throw new NotFoundError('USER_NOT_FOUND', 'User not found');
      }
    }

    // One active share per grantee, including the instance-wide row (docs/03 §3.3.15). Sharing
    // twice is not an error — it just means what it already meant.
    const existing = await this.collections.findActiveShare(id, input.granteeUserId);
    const share = existing ?? (await this.collections.createShare(id, input.granteeUserId));

    return {
      id: share.id,
      granteeUserId: share.granteeUserId,
      granteeName: share.granteeName,
      createdAt: share.createdAt.toISOString(),
    };
  }
}

export class RevokeShare {
  constructor(
    private readonly collections: CollectionRepository,
    private readonly clock: Clock,
  ) {}

  async execute(viewer: Viewer, id: string, shareId: string): Promise<{ ok: true }> {
    await requireManageable(this.collections, viewer, id);

    // 🔒 The share is revoked within the collection the caller was authorized for: a share id
    // belonging to somebody else's collection is not a share this caller has, so it reads as
    // missing (docs/08 §8.5).
    const revoked = await this.collections.revokeShare(id, shareId, this.clock.now());
    if (!revoked) throw new NotFoundError('NOT_FOUND', 'Share not found');
    return { ok: true };
  }
}

function toDto(collection: CollectionSummary, viewer: Viewer): CollectionDto {
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    ownerId: collection.ownerId,
    ownerName: collection.ownerName,
    mine: collection.ownerId === viewer.id,
    sharedByMe: collection.sharedByMe,
    sharedWithMe: collection.sharedWithMe,
    itemCount: collection.itemCount,
    createdAt: collection.createdAt.toISOString(),
  };
}
