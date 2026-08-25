import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { artifactKeys } from '../../src/server/application/storage/artifact-keys';
import { testPrisma } from './db';

// A document, the way it looks in the database since ADR-025: a row in `documents` that carries no
// bytes, one row per file in `files` that carries all of them, `document_pages` rows saying which
// pages of which file the document is a list of, and — for a file on a volume — a `file_ref`
// pointing at the file (docs/03 §3.3.16–17).
// Written straight to the database on purpose: the suites that use this are about the read model,
// and how documents get there is the scan and ingest suites' business.

let seq = 0;

function next(): number {
  seq += 1;
  return seq;
}

export type SeedFileOptions = Partial<Prisma.FileUncheckedCreateInput> & {
  // Where these bytes were seen, when they live on a volume. Defaults to the document's library.
  libraryId?: string;
  path?: string;
  mtime?: Date;
  refStatus?: 'DISCOVERED' | 'HASHED' | 'MISSING';
  missingSince?: Date | null;
};

export type SeedDocumentOptions = {
  // Any column of `documents`; what is not given follows a processed document nobody has touched.
  document?: Partial<Prisma.DocumentUncheckedCreateInput>;
  // The library the files lie in. Absent means a managed document — an upload, or something we made.
  libraryId?: string;
  // One file unless a test says otherwise, in the order they are given.
  files?: SeedFileOptions[];
};

export type SeededDocument = {
  id: string;
  fileIds: string[];
  fileNames: string[];
  contentHashes: string[];
  // The library-relative paths of the refs, in file order; empty for a managed file.
  paths: string[];
};

export async function seedDocument(options: SeedDocumentOptions = {}): Promise<SeededDocument> {
  const document = await testPrisma().document.create({
    data: {
      title: `Document ${next()}`,
      canonicalStatus: 'DONE',
      previewStatus: 'DONE',
      markdownStatus: 'DONE',
      analysisStatus: 'DONE',
      fieldsStatus: 'SKIPPED',
      vectorizationStatus: 'SKIPPED',
      ...options.document,
    },
  });

  const seeded: SeededDocument = {
    id: document.id,
    fileIds: [],
    fileNames: [],
    contentHashes: [],
    paths: [],
  };

  let nextPosition = 0;
  for (const spec of options.files ?? [{}]) {
    const index = next();
    // Where the bytes were seen belongs to the ref; everything else is a column of the file itself.
    const {
      libraryId: refLibraryId,
      path: refPath,
      mtime,
      refStatus,
      missingSince,
      ...columns
    } = spec;
    const libraryId = refLibraryId ?? options.libraryId;
    const origin = columns.origin ?? (libraryId === undefined ? 'MANAGED' : 'LIBRARY');
    const ext = columns.ext ?? 'pdf';
    const name = columns.name ?? `file-${index}.${ext}`;
    const sizeBytes = columns.sizeBytes ?? 2048n;
    // Unique among live files (docs/03 §3.3.16), so it is derived from the row rather than shared.
    const contentHash =
      columns.contentHash ?? createHash('sha256').update(`seed-file-${index}`).digest('hex');

    const file = await testPrisma().file.create({
      data: {
        ...columns,
        contentHash,
        origin,
        mimeType: columns.mimeType ?? 'application/pdf',
        ext,
        sizeBytes,
        name,
      },
    });

    // A managed file's key contains the id the database assigned, so it is written once that is
    // known (docs/09 §9.2).
    if (origin === 'MANAGED' && columns.storageKey === undefined) {
      await testPrisma().file.update({
        where: { id: file.id },
        data: { storageKey: artifactKeys.fileOriginal(file.id, ext) },
      });
    }

    // Its own pages where the fixture says how many there are, and one entry standing for the file
    // whole where it does not — the two states of docs/03 §3.3.17.
    const pageCount = file.pageCount === null || file.pageCount < 1 ? null : file.pageCount;
    const indices: (number | null)[] =
      pageCount === null ? [null] : Array.from({ length: pageCount }, (unused, at) => at);
    await testPrisma().documentPage.createMany({
      data: indices.map((pageIndex, offset) => ({
        documentId: document.id,
        position: nextPosition + offset,
        fileId: file.id,
        pageIndex,
      })),
    });
    nextPosition += indices.length;

    const path = refPath ?? `folder/${name}`;
    if (libraryId !== undefined) {
      const status = refStatus ?? 'HASHED';
      await testPrisma().fileRef.create({
        data: {
          libraryId,
          fileId: file.id,
          path,
          size: sizeBytes,
          mtime: mtime ?? new Date('2026-01-01T00:00:00.000Z'),
          status,
          contentHash,
          ...(status === 'MISSING'
            ? { missingSince: missingSince ?? new Date('2026-02-01T00:00:00.000Z') }
            : {}),
        },
      });
      seeded.paths.push(path);
    } else {
      seeded.paths.push('');
    }

    seeded.fileIds.push(file.id);
    seeded.fileNames.push(name);
    seeded.contentHashes.push(contentHash);
  }

  return seeded;
}

// A library rooted at a path of its own: two libraries may not share one root, so a suite that needs
// several needs several paths (docs/03 §3.3.6).
export async function seedLibrary(
  options: {
    visibility?: 'ALL_USERS' | 'RESTRICTED';
    rootPath?: string;
    name?: string;
    userIds?: string[];
  } = {},
): Promise<string> {
  const index = next();
  const library = await testPrisma().library.create({
    data: {
      name: options.name ?? `Library ${index}`,
      rootPath: options.rootPath ?? `lib-${index}`,
      visibility: options.visibility ?? 'ALL_USERS',
      excludeGlobs: [],
      scanIntervalMinutes: 15,
      access: { create: (options.userIds ?? []).map((userId) => ({ userId })) },
    },
  });
  return library.id;
}
