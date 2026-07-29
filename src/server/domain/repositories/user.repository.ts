import type { Language, Theme, UserRole } from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { User } from '../entities/user';

export type CreateUserInput = {
  email: string;
  passwordHash: string;
  displayName: string;
  role: UserRole;
  language: Language;
};

export type UpdateUserInput = {
  displayName?: string;
  language?: Language;
  theme?: Theme;
  passwordHash?: string;
  role?: UserRole;
  deactivatedAt?: Date | null;
};

// Repository port (docs/06 §6.2): accepts and returns domain entities, never Prisma types.
// Methods take an optional transaction handle so use cases can compose them in one UnitOfWork.
export abstract class UserRepository {
  abstract findById(id: string, tx?: TransactionHandle): Promise<User | null>;

  abstract findActiveByEmail(email: string, tx?: TransactionHandle): Promise<User | null>;

  // Onboarding gate (docs/08 §8.1.1): onboarding is required while no active user exists.
  abstract countActive(tx?: TransactionHandle): Promise<number>;

  // Serializes first-admin creation across concurrent transactions. Counting and inserting is not
  // atomic on its own — two onboardings with different emails would both read zero and both become
  // admins, which docs/08 §8.1.1 forbids ("a race between two onboardings is resolved by the
  // uniqueness of the 'first' inside a transaction"). Released when the transaction ends.
  abstract lockOnboarding(tx: TransactionHandle): Promise<void>;

  // LAST_ADMIN guard (docs/03 §3.3.1): counts active, non-deactivated admins.
  abstract countActiveAdmins(tx?: TransactionHandle): Promise<number>;

  // Throws EmailAlreadyRegistered when an active user with that email exists — the race is resolved
  // by the partial unique index, not by a prior read (docs/08 §8.1.3).
  abstract create(input: CreateUserInput, tx?: TransactionHandle): Promise<User>;

  abstract update(id: string, input: UpdateUserInput, tx?: TransactionHandle): Promise<User>;

  // Admin listing, sorted createdAt ascending with cursor pagination (docs/07 §7.1, §7.3).
  abstract list(query: ListUsersInput, tx?: TransactionHandle): Promise<UserPage>;
}

export type ListUsersInput = {
  limit: number;
  cursor?: string | undefined;
};

export type UserPage = {
  items: User[];
  nextCursor: string | null;
};
