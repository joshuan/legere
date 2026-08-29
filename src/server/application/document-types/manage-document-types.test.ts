import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../../../test/helpers/fakes';
import { NotFoundError } from '../../domain/errors/domain-error';
import {
  DocumentTypeRepository,
  type DocumentType,
  type DocumentTypeWithCount,
} from '../../domain/repositories/document-type.repository';
import { DeleteDocumentType } from './manage-document-types';

// DELETE /api/admin/document-types/:id (docs/07 §7.3): a soft delete plus the cascade that keeps the
// documents which carried the type from pointing at something that is no longer there.

const TYPE: DocumentType = {
  id: 'type-1',
  slug: 'invoice',
  name: 'Invoice',
  description: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

// Counts documents rather than holding them: what these tests watch is how the reset is *cut up*,
// because doing it in one statement is what could not finish (docs/07 §7.3).
class CountingDocumentTypes extends DocumentTypeRepository {
  readonly batches: number[] = [];
  softDeletedAt: Date | null = null;
  // How many documents still carry the type.
  constructor(private remaining: number) {
    super();
  }

  findById(id: string): Promise<DocumentType | null> {
    return Promise.resolve(id === TYPE.id ? TYPE : null);
  }

  clearTypeFromDocuments(_typeId: string, limit: number): Promise<number> {
    const cleared = Math.min(limit, this.remaining);
    this.remaining -= cleared;
    this.batches.push(cleared);
    return Promise.resolve(cleared);
  }

  softDelete(_id: string, deletedAt: Date): Promise<void> {
    this.softDeletedAt = deletedAt;
    return Promise.resolve();
  }

  listActive(): Promise<DocumentType[]> {
    return Promise.reject(new Error('unused'));
  }
  listActiveWithCounts(): Promise<DocumentTypeWithCount[]> {
    return Promise.reject(new Error('unused'));
  }
  findActiveBySlug(): Promise<DocumentType | null> {
    return Promise.reject(new Error('unused'));
  }
  create(): Promise<DocumentType> {
    return Promise.reject(new Error('unused'));
  }
  update(): Promise<DocumentType> {
    return Promise.reject(new Error('unused'));
  }
}

describe('DeleteDocumentType', () => {
  const deleteType = (repository: DocumentTypeRepository): DeleteDocumentType =>
    new DeleteDocumentType(repository, new FixedClock());

  it('refuses a type that is not there', async () => {
    await expect(
      deleteType(new CountingDocumentTypes(0)).execute('missing'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('clears a small archive in one pass and soft-deletes the type', async () => {
    const documentTypes = new CountingDocumentTypes(12);

    const answer = await deleteType(documentTypes).execute(TYPE.id);

    expect(answer).toEqual({ ok: true, documentsReset: 12 });
    expect(documentTypes.batches).toEqual([12]);
    expect(documentTypes.softDeletedAt).not.toBeNull();
  });

  // 🔒 SEC-80 (docs/07 §7.3). The reset used to be one `updateMany` inside one interactive
  // transaction, and its size is not the admin's to choose: it is however many documents ordinary
  // users filed under this type. Each of those rows carries a `type_id` btree, so the update cannot
  // be HOT and writes a new tuple into every index the row has — the GIN over the whole of its
  // Markdown included. Past a few thousand documents the transaction hit Prisma's five-second
  // ceiling with `P2028`, which is neither a `DomainError` nor an `HttpException`: the admin got
  // `500 INTERNAL` and the type could not be deleted at all, on an archive any user could grow.
  it('cuts a large archive into bounded batches instead of one statement', async () => {
    const documentTypes = new CountingDocumentTypes(1300);

    const answer = await deleteType(documentTypes).execute(TYPE.id);

    expect(answer.documentsReset).toBe(1300);
    // 500 at a time, and a short last batch is how the loop knows it is done.
    expect(documentTypes.batches).toEqual([500, 500, 300]);
  });

  // Exactly the multiple of the batch size, which is the case a `< limit` test would loop for ever
  // on if it were written as `while (cleared > 0)` — one extra empty pass, and then done.
  it('stops on the empty pass when the archive divides evenly', async () => {
    const documentTypes = new CountingDocumentTypes(1000);

    const answer = await deleteType(documentTypes).execute(TYPE.id);

    expect(answer.documentsReset).toBe(1000);
    expect(documentTypes.batches).toEqual([500, 500, 0]);
  });

  // The reset comes first and the soft delete last, so that an interruption leaves the type alive
  // over a partly-cleared set rather than a set pointing at a type nobody can see.
  it('soft-deletes the type only after the documents have let go of it', async () => {
    const documentTypes = new CountingDocumentTypes(600);
    const order: string[] = [];
    const clear = documentTypes.clearTypeFromDocuments.bind(documentTypes);
    documentTypes.clearTypeFromDocuments = (typeId: string, limit: number): Promise<number> => {
      order.push('clear');
      return clear(typeId, limit);
    };
    const remove = documentTypes.softDelete.bind(documentTypes);
    documentTypes.softDelete = (id: string, at: Date): Promise<void> => {
      order.push('softDelete');
      return remove(id, at);
    };

    await deleteType(documentTypes).execute(TYPE.id);

    expect(order).toEqual(['clear', 'clear', 'softDelete']);
  });
});
