import argon2 from 'argon2';
import { PrismaClient, type Prisma } from '@prisma/client';

// Dev/test seed (docs/04 §4.6). Idempotent: running it twice creates no duplicates.
// Deliberately creates no documents — those appear via a real scan, which keeps the seed honest.

const prisma = new PrismaClient();

// OWASP parameters (docs/08 §8.1.5); mirrored by Argon2PasswordHasher in M2.2.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

const DEV_PASSWORD = 'password';

// The same list migration 1 inserts (docs/03 §3.3.12) so dev and prod agree.
const DEFAULT_CATEGORIES: ReadonlyArray<{ slug: string; name: string; description: string }> = [
  { slug: 'passport', name: 'Passport', description: 'Passports and travel documents.' },
  { slug: 'id-card', name: 'ID card', description: 'National ID cards, driver licenses, permits.' },
  { slug: 'contract', name: 'Contract', description: 'Agreements, contracts, addenda.' },
  { slug: 'invoice', name: 'Invoice', description: 'Invoices and bills issued or received.' },
  { slug: 'receipt', name: 'Receipt', description: 'Purchase receipts and payment confirmations.' },
  {
    slug: 'certificate',
    name: 'Certificate',
    description: 'Certificates, diplomas, registrations.',
  },
  {
    slug: 'medical',
    name: 'Medical',
    description: 'Medical records, prescriptions, test results.',
  },
  {
    slug: 'financial',
    name: 'Financial',
    description: 'Bank statements, tax filings, financial reports.',
  },
  {
    slug: 'manual',
    name: 'Manual',
    description: 'Manuals, instructions, technical documentation.',
  },
  { slug: 'letter', name: 'Letter', description: 'Letters and official correspondence.' },
  {
    slug: 'other',
    name: 'Other',
    description: 'Documents that do not fit any other documentType.',
  },
];

// Uniqueness for soft-deletable models lives in partial unique indexes (docs/04 §4.3), which Prisma
// cannot target with upsert — hence find-then-create against the active row.
async function ensureUser(
  email: string,
  role: 'ADMIN' | 'USER',
  passwordHash: string,
): Promise<void> {
  const existing = await prisma.user.findFirst({ where: { email, deletedAt: null } });
  if (existing) return;
  const localPart = email.split('@')[0] ?? email;
  await prisma.user.create({
    data: { email, passwordHash, displayName: localPart, role, language: 'EN' },
  });
}

async function ensureCategories(): Promise<void> {
  for (const documentType of DEFAULT_CATEGORIES) {
    const existing = await prisma.documentType.findFirst({
      where: { slug: documentType.slug, deletedAt: null },
    });
    if (existing) continue;
    await prisma.documentType.create({ data: documentType });
  }
}

// One library over the whole mounted volume: rootPath "" is LIBRARY_ROOT itself; dev compose mounts
// ./dev-library there. ALL_USERS so both seeded accounts see its content.
async function ensureDevLibrary(): Promise<void> {
  const existing = await prisma.library.findFirst({ where: { rootPath: '', deletedAt: null } });
  if (existing) return;
  const data: Prisma.LibraryCreateInput = {
    name: 'Dev library',
    rootPath: '',
    enabled: true,
    visibility: 'ALL_USERS',
    scanIntervalMinutes: 15,
    excludeGlobs: ['**/.*'],
  };
  await prisma.library.create({ data });
}

async function main(): Promise<void> {
  const passwordHash = await argon2.hash(DEV_PASSWORD, ARGON2_OPTIONS);

  await ensureUser('admin@legere.local', 'ADMIN', passwordHash);
  await ensureUser('user@legere.local', 'USER', passwordHash);
  await ensureCategories();
  await ensureDevLibrary();

  const [users, documentTypes, libraries] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.documentType.count({ where: { deletedAt: null } }),
    prisma.library.count({ where: { deletedAt: null } }),
  ]);
  process.stdout.write(
    `Seed complete: ${users} users, ${documentTypes} documentTypes, ${libraries} libraries.\n`,
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
