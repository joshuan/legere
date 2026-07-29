import type { Language, Theme, UserRole } from '../../../shared/contracts/enums';

// User entity (docs/03 §3.3.1). Plain data + behaviour; no framework, no Prisma types.
export type User = {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role: UserRole;
  language: Language;
  theme: Theme;
  deactivatedAt: Date | null;
  createdAt: Date;
};

// Active session requires the user to be neither deleted nor deactivated (docs/03 §3.3.2).
export function isUserActive(user: User): boolean {
  return user.deactivatedAt === null;
}

// displayName defaults to the local part of the email (docs/03 §3.3.1, docs/08 §8.1.3 step 3).
export function defaultDisplayName(email: string): string {
  const localPart = email.split('@')[0];
  return localPart !== undefined && localPart !== '' ? localPart : email;
}
