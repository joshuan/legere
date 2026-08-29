import {
  isIdentityRotation,
  type Crop,
  type PageOrder,
  type PageRotations,
  type Rotation,
} from '../../../shared/contracts/documents';
import type { ValueSource } from '../../../shared/contracts/enums';
import type { File } from './file';

// One page of one document (docs/03 §3.3.17, ADR-025): read out of one file, standing a particular
// way up, showing a particular part of itself. This — not the file — is what a document is an
// ordered list of, which is what lets a page be turned on its own, two documents read one file, and
// a photograph go between page two and page three of a PDF.
export type DocumentPage = {
  id: string;
  documentId: string;
  // 0-based and contiguous inside one document; reordering rewrites positions.
  position: number;
  fileId: string;
  // Which page of the file, by the file's own 0-based index — the index the page strip shows and the
  // page-thumb route serves. `null` is "this file, whole, in the order it arrived": the entry a file
  // takes while nobody has counted its pages, which the first canonical build expands into one entry
  // per page (docs/05 §5.5 step 1).
  pageIndex: number | null;
  // Which way up this page lies, `null` for the way it arrived. A mirror is meaningful only for a
  // page of an image: a PDF page arrives the way its producer laid it out.
  turn: Rotation | null;
  // How much of the page is paper, and who said so. A crop somebody dragged is MANUAL and no rebuild
  // replaces it (docs/03 §3.3.17).
  crop: Crop | null;
  cropSource: ValueSource;
};

// What one entry says, without where it stands: the shape every rewrite of a document's list is
// written in. An entry that was already there keeps its id, so a rebuild does not invalidate
// anything addressing it; a new one has none until it is written.
export type PageEntry = {
  id?: string | undefined;
  fileId: string;
  pageIndex: number | null;
  turn: Rotation | null;
  crop: Crop | null;
  cropSource: ValueSource;
};

// 🔒 How many distinct **files** the pages of one document may name (docs/05 §5.4a). Not how many
// pages: a four-hundred-page scan is one file the canonical build opens once, and adding a page of a
// file it already holds costs nothing. Every distinct file, by contrast, is opened whole, converted,
// and its part held until the merge — so this is the number that decides the build's peak memory,
// and until now nothing decided it at all: `attach` read `max(position)` and inserted, counting
// nothing, and a repeated `POST /documents/:id/files` or `combine` grew the list until the disk or
// the container gave out.
//
// Two hundred is far above any document a person files — a contract with its annexes, a scan set of
// a folder — and far below where two hundred whole files could fit in the 256 MiB one build may hold
// anyway, so the byte bound is what a real archive meets and this is the backstop that makes the
// count a decision rather than a consequence.
export const MAX_FILES_PER_DOCUMENT = 200;

// The whole ordered list a document holds, read back off the files it was answered with: the pages
// of every file, in the order the document holds them (docs/03 §3.3.17). One place, because every
// composition edit starts here — with the list as it stands — and answers with the list it should
// hold instead.
export function orderedPages(
  files: ReadonlyArray<{ pages: readonly DocumentPage[] }>,
): DocumentPage[] {
  return files.flatMap((file) => [...file.pages]).sort((a, b) => a.position - b.position);
}

// An entry without where it stands: what a rewrite is written in, keeping the id so that a page that
// was already there stays the same page.
export function entryOf(page: DocumentPage): PageEntry {
  return {
    id: page.id,
    fileId: page.fileId,
    pageIndex: page.pageIndex,
    turn: page.turn,
    crop: page.crop,
    cropSource: page.cropSource,
  };
}

// The entries a file joins a document as: its own pages where a build has counted them, and one
// entry standing for it whole where none has — the transitional state of ADR-025, which the next
// build ends (docs/03 §3.3.17).
export function pagesForFile(file: Pick<File, 'id' | 'pageCount'>): PageEntry[] {
  const count = file.pageCount === null || file.pageCount < 1 ? null : file.pageCount;
  const indices: Array<number | null> =
    count === null ? [null] : Array.from({ length: count }, (unused, index) => index);
  return indices.map((pageIndex) => ({
    fileId: file.id,
    pageIndex,
    turn: null,
    crop: null,
    cropSource: 'NONE',
  }));
}

// Entries put **at a position** in the list — the whole of what "between page two and page three"
// means (ADR-025). The position is a place among the entries the document holds, so a file held
// whole is one place: the insert lands before it or after it, never inside it (docs/03 §3.3.17).
export function withInsertedAt(
  pages: readonly PageEntry[],
  at: number,
  inserted: readonly PageEntry[],
): PageEntry[] {
  return [...pages.slice(0, at), ...inserted, ...pages.slice(at)];
}

// The turn a build should apply to this page, or `null` for "the way it arrived" — which covers both
// a page that carries none and one whose turns were pressed round in a circle, because a quarter
// turn of nothing is not worth re-encoding a page for (docs/05 §5.5 step 1).
export function effectiveTurn(page: Pick<DocumentPage, 'turn'>): Rotation | null {
  return isIdentityRotation(page.turn) ? null : page.turn;
}

// A crop somebody dragged is theirs: MANUAL is what stops the next rebuild from replacing it with
// what a detector found (docs/03 §3.3.17).
export function canOverwriteCrop(page: Pick<DocumentPage, 'cropSource'>): boolean {
  return page.cropSource !== 'MANUAL';
}

// The entry a file takes while nobody has counted its pages. It is the one two-level state left in
// the model, and the build is where it ends (ADR-025).
export function standsForWholeFile(page: Pick<DocumentPage, 'pageIndex'>): boolean {
  return page.pageIndex === null;
}

// --- what one file says about the document reading it ----------------------------------------
//
// The API and the screens still speak of a file's crop, its turn, the order of its pages and which
// way up each of them lies (docs/07 §7.3). None of that is stored on the file any more, so it is
// read back off the pages that file is read as in *this* document — which is also why two documents
// can crop one photograph differently and neither reads the other's answer.

// The pages one file is read as here, in the order this document holds them.
export function pagesOfFile(
  pages: readonly DocumentPage[],
  fileId: string,
): readonly DocumentPage[] {
  return pages.filter((page) => page.fileId === fileId);
}

// The crop of the page an image is read as. An image is one page, so there is one answer; a file
// held whole has whatever was said about it before anything counted its pages.
export function fileCropOf(pages: readonly DocumentPage[]): Crop | null {
  return pages[0]?.crop ?? null;
}

export function fileCropSourceOf(pages: readonly DocumentPage[]): ValueSource {
  return pages[0]?.cropSource ?? 'NONE';
}

// The turn of the page an image is read as, on the same terms as the crop above.
export function fileTurnOf(pages: readonly DocumentPage[]): Rotation | null {
  const first = pages[0];
  if (first === undefined) return null;
  return effectiveTurn(first);
}

// The order this document reads a file's pages in, as a permutation of the file's own 0-based
// indices — or `null` for "the order they arrived in", which is what a file held whole, a file whose
// pages are not all here, and a file read straight through all answer (docs/07 §7.3).
export function filePageOrderOf(
  pages: readonly DocumentPage[],
  pageCount: number | null,
): PageOrder | null {
  if (pageCount === null || pages.length !== pageCount) return null;
  const order: number[] = [];
  for (const page of pages) {
    if (page.pageIndex === null) return null;
    order.push(page.pageIndex);
  }
  if (order.every((index, position) => index === position)) return null;
  return order;
}

// Which way up each of a file's pages lies, **by the file's own page index** rather than by the
// order this document reads them in — the shape `07 §7.3` promises and the page strip draws. `null`
// where nothing is turned, so a file nobody has touched says so in one word.
export function filePageRotationsOf(
  pages: readonly DocumentPage[],
  pageCount: number | null,
): PageRotations | null {
  if (pageCount === null || pageCount < 1) return null;

  const turns = new Array<number>(pageCount).fill(0);
  let turned = false;
  for (const page of pages) {
    const index = page.pageIndex;
    if (index === null || index < 0 || index >= pageCount) continue;
    const turn = effectiveTurn(page);
    if (turn === null) continue;
    turns[index] = turn.quarterTurns;
    turned = true;
  }
  if (!turned) return null;
  return turns.map(quarterTurnOf);
}

// The contract's turn is one of four values, and an array of numbers is not one of four values until
// something says so. Anything outside the range is a row written by another version and reads as no
// turn at all, exactly as an unreadable crop does (docs/05 §5.5 step 1).
function quarterTurnOf(value: number): 0 | 1 | 2 | 3 {
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  return 0;
}

// --- rewriting the list --------------------------------------------------------------------
//
// Every composition edit is the same shape: read the document's pages, answer with the pages it
// should have, and write the whole list back (docs/03 §3.3.17). Written as pure functions over the
// list so that what an edit means is decided here rather than in SQL, and so that the awkward cases
// — a file held whole, a file whose pages are not contiguous — have one answer each.

// A crop written on **one** entry, named by its id (docs/03 §3.3.17): the page somebody dragged the
// corners of, and nothing else in the list stirs — not the other pages of its file, and not the same
// page read by another document.
export function withPageCrop(
  pages: readonly PageEntry[],
  pageId: string,
  crop: Crop | null,
  cropSource: ValueSource,
): PageEntry[] {
  return pages.map((page) => (page.id === pageId ? { ...page, crop, cropSource } : page));
}

// And the same for the turn of one page: a forty-page scan has three pages lying sideways and not
// forty (docs/05 §5.6).
export function withPageTurn(
  pages: readonly PageEntry[],
  pageId: string,
  turn: Rotation | null,
): PageEntry[] {
  return pages.map((page) => (page.id === pageId ? { ...page, turn } : page));
}

// A crop said about a file is said about the pages that file is read as here. An image is one page;
// a file held whole is the entry standing for it (ADR-025).
export function withFileCrop(
  pages: readonly PageEntry[],
  fileId: string,
  crop: Crop | null,
  cropSource: ValueSource,
): PageEntry[] {
  return pages.map((page) => (page.fileId === fileId ? { ...page, crop, cropSource } : page));
}

// And the same for a turn asked of a whole file, which only an image takes: one page, one turn.
export function withFileTurn(
  pages: readonly PageEntry[],
  fileId: string,
  turn: Rotation | null,
): PageEntry[] {
  return pages.map((page) => (page.fileId === fileId ? { ...page, turn } : page));
}

// A turn per page of one file, **by the file's own page index** — the shape `07 §7.3` takes. A page
// the list does not reach stands as it was, and `null` puts every page of the file back the way it
// arrived.
export function withFilePageTurns(
  pages: readonly PageEntry[],
  fileId: string,
  quarterTurns: readonly number[] | null,
): PageEntry[] {
  return pages.map((page) => {
    if (page.fileId !== fileId) return page;
    if (quarterTurns === null) return { ...page, turn: null };
    const index = page.pageIndex;
    if (index === null) return { ...page, turn: null };
    const asked = quarterTurns[index];
    if (asked === undefined) return page;
    return {
      ...page,
      turn: asked === 0 ? null : { quarterTurns: quarterTurnOf(asked), mirrored: false },
    };
  });
}

// The pages of one file put into an order of the caller's choosing — a permutation of the file's own
// 0-based indices, or `null` for the order they arrived in. What moves is which of that file's pages
// sits in which of the places this document already gives it, so nothing else in the list stirs.
export function withFilePageOrder(
  pages: readonly PageEntry[],
  fileId: string,
  order: readonly number[] | null,
): PageEntry[] {
  const own = pages.filter((page) => page.fileId === fileId);
  if (own.length === 0) return [...pages];

  const byIndex = new Map<number, PageEntry>();
  for (const page of own) {
    if (page.pageIndex !== null) byIndex.set(page.pageIndex, page);
  }
  const wanted = order === null ? [...byIndex.keys()].sort((a, b) => a - b) : order;
  // An index this document does not hold a page for is no instruction at all: what is left is put
  // back in the file's own order, so the answer is always exactly the pages that were there.
  const reordered = wanted.flatMap((index) => {
    const page = byIndex.get(index);
    return page === undefined ? [] : [page];
  });
  if (reordered.length !== own.length) return [...pages];

  let taken = 0;
  return pages.map((page) => {
    if (page.fileId !== fileId) return page;
    const next = reordered[taken];
    taken += 1;
    return next ?? page;
  });
}

// An entry joining another document is a new entry there: nothing addresses a page across documents,
// and a row carries the document it belongs to (docs/03 §3.3.17). What it keeps is everything that
// says what the page *is* — which file, which page of it, which way up, how much of it is paper — so
// a page that changes hands arrives as the page it was and never as a fresh reading of its file.
export function withoutId(page: PageEntry): PageEntry {
  return {
    fileId: page.fileId,
    pageIndex: page.pageIndex,
    turn: page.turn,
    crop: page.crop,
    cropSource: page.cropSource,
  };
}

// 🔒 A file's entries replaced by another file's, **where the first of them stood** (docs/05 §5.6).
// The rest of the list does not move: a photograph somebody put between pages two and three is still
// between pages two and three when it is re-taken, which is exactly what regrouping the list into
// one block per file — what a reorder by file does — would destroy. The old file's other entries go
// with it, because what replaced them is one file and it says how many pages it has for itself.
export function withFileReplaced(
  pages: readonly PageEntry[],
  fileId: string,
  replacement: readonly PageEntry[],
): PageEntry[] {
  let planted = false;
  return pages.flatMap((page): PageEntry[] => {
    if (page.fileId !== fileId) return [page];
    if (planted) return [];
    planted = true;
    return [...replacement];
  });
}

// The end of the one two-level state (ADR-025): where a build has counted the pages of a file this
// document holds whole, the entry becomes one entry per page, in the file's own order, keeping what
// was said about the file whole. A file nothing could count keeps the entry it has — a document is
// not made smaller by a format we cannot read.
export function withExpandedPages(
  pages: readonly PageEntry[],
  pageCounts: ReadonlyMap<string, number>,
): PageEntry[] {
  return pages.flatMap((page): PageEntry[] => {
    if (page.pageIndex !== null) return [page];
    const count = pageCounts.get(page.fileId);
    if (count === undefined || count < 1) return [page];
    // The entry that was there keeps its id for the first of the pages it becomes; the rest are new.
    return Array.from({ length: count }, (unused, index) => ({
      ...(index === 0 ? { id: page.id } : {}),
      fileId: page.fileId,
      pageIndex: index,
      turn: page.turn,
      crop: page.crop,
      cropSource: page.cropSource,
    }));
  });
}

// 🔒 Whether two readings of a document's list are the same reading: the same entries, in the same
// order, each of them the same row saying the same thing (docs/03 §3.3.17). This is the precondition
// of every composition edit — a rewrite is computed from a list the caller was shown, and writing it
// against a list that has moved carries the older list back with it, restoring a page somebody
// removed and pointing it at a file that is now in the trash.
//
// The ids as well as the payload, and for different reasons: the ids catch a page added, removed or
// moved, and the payload catches a crop or a turn that would otherwise be silently reverted by an
// edit about some other page entirely.
export function sameListing(pages: readonly PageEntry[], next: readonly PageEntry[]): boolean {
  if (pages.length !== next.length) return false;
  if (!pages.every((page, index) => next[index]?.id === page.id)) return false;
  return samePages(pages, next);
}

// Whether a rewrite would change anything at all — asked before writing, because the expansion above
// runs on every build and a build that changed nothing should write nothing.
export function samePages(pages: readonly PageEntry[], next: readonly PageEntry[]): boolean {
  if (pages.length !== next.length) return false;
  return pages.every((page, index) => {
    const entry = next[index];
    return (
      entry !== undefined &&
      entry.fileId === page.fileId &&
      entry.pageIndex === page.pageIndex &&
      entry.cropSource === page.cropSource &&
      JSON.stringify(entry.turn) === JSON.stringify(page.turn) &&
      JSON.stringify(entry.crop) === JSON.stringify(page.crop)
    );
  });
}
