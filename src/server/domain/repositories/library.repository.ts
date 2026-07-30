import type { LibraryVisibility } from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Library } from '../entities/library';
import type { RelativePath } from '../value-objects/relative-path';

export type CreateLibraryInput = {
  name: string;
  rootPath: RelativePath;
  visibility: LibraryVisibility;
  scanIntervalMinutes: number;
  excludeGlobs: string[];
};

// rootPath is deliberately absent: it is immutable (docs/07 §7.3).
export type UpdateLibraryInput = {
  name?: string;
  enabled?: boolean;
  visibility?: LibraryVisibility;
  scanIntervalMinutes?: number;
  excludeGlobs?: string[];
};

export type LibraryCounts = {
  libraryId: string;
  files: number;
  documents: number;
  missing: number;
};

export abstract class LibraryRepository {
  abstract findById(id: string, tx?: TransactionHandle): Promise<Library | null>;

  abstract listActive(tx?: TransactionHandle): Promise<Library[]>;

  // Libraries a specific user may read: ALL_USERS plus their explicit grants (docs/08 §8.5).
  abstract listVisibleTo(userId: string, tx?: TransactionHandle): Promise<Library[]>;

  abstract create(input: CreateLibraryInput, tx?: TransactionHandle): Promise<Library>;

  abstract update(id: string, input: UpdateLibraryInput, tx?: TransactionHandle): Promise<Library>;

  // Soft delete (ADR-015): the row and its FileRefs stay, the content leaves every listing.
  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

  // FileRef/document counters for the admin table (docs/07 §7.3).
  abstract countsFor(libraryIds: string[], tx?: TransactionHandle): Promise<LibraryCounts[]>;

  // LibraryAccess rows are a pure ACL, replaced wholesale on update (docs/03 §3.3.7).
  abstract listUserIds(libraryId: string, tx?: TransactionHandle): Promise<string[]>;

  abstract replaceUserIds(
    libraryId: string,
    userIds: string[],
    tx?: TransactionHandle,
  ): Promise<void>;
}
