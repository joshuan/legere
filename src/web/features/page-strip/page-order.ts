import {
  isIdentityRotation,
  turnedRotation,
  type DocumentFileDto,
  type DocumentPageDto,
  type Rotation,
  type Turn,
} from '../../../shared/contracts/documents';

// The arithmetic of a document's page list (docs/03 §3.3.17, docs/11 §11.5a), kept out of the
// component so that "where does this page land", "what has changed since the server last spoke" and
// "may this page be turned at all" are answerable without rendering anything.

// One page taken out of the order and put back at `to`, the rest closing up behind it — the whole of
// what both the drag and the arrow keys do. Positions outside the strip are refused rather than
// clamped: a page at the end asked to move further right stays where it is, which is what makes the
// last arrow key press a no-op instead of a wrap nobody asked for.
export function movePage(order: readonly string[], from: number, to: number): string[] {
  const moved = order[from];
  if (moved === undefined || to === from || to < 0 || to >= order.length) return [...order];
  const rest = order.filter((unused, index) => index !== from);
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
}

export function sameOrder(one: readonly string[], other: readonly string[]): boolean {
  return one.length === other.length && one.every((id, index) => id === other[index]);
}

// The order the document says it holds: the page ids, in position order. The server answers in that
// order already (docs/07 §7.3); sorting here means the strip never depends on it having done so.
export function storedOrder(pages: readonly DocumentPageDto[]): string[] {
  return [...pages].sort((a, b) => a.position - b.position).map((page) => page.id);
}

// Which way up a page lies once the strip's pending turns are taken into account: what the tile
// draws and what Save would send. A page nobody has touched answers with what the server said.
export function turnOf(
  page: DocumentPageDto,
  pending: ReadonlyMap<string, Rotation | null>,
): Rotation | null {
  const asked = pending.get(page.id);
  return asked === undefined ? page.turn : asked;
}

// One press of turn-left or turn-right, applied to whatever the page reads now. Four presses of the
// same button bring a page back where it started, which is what a person expects of a thing that
// turns — and a turn of nothing at all is stored as nothing, so a page pressed round in a circle
// stops claiming to be turned (docs/03 §3.3.17).
export function turnedPage(current: Rotation | null, turn: Turn): Rotation | null {
  const next = turnedRotation(current, turn);
  return isIdentityRotation(next) ? null : next;
}

// Whether the strip is holding a turn the server has not been told about. Compared value by value
// rather than by identity: `null` and a turn of nothing at all read the same to a build, so they
// read the same here (docs/05 §5.5 step 1).
export function sameTurn(one: Rotation | null, other: Rotation | null): boolean {
  if (isIdentityRotation(one) && isIdentityRotation(other)) return true;
  if (one === null || other === null) return false;
  return one.quarterTurns === other.quarterTurns && one.mirrored === other.mirrored;
}

// The pages whose turn Save has to send, and nothing else: a page whose pending turn says what the
// document already says is not an edit, and a request that changes nothing is a request that says
// nothing (docs/11 §11.5a).
export function turnsToSave(
  pages: readonly DocumentPageDto[],
  pending: ReadonlyMap<string, Rotation | null>,
): Array<{ pageId: string; turn: Rotation | null }> {
  return pages.flatMap((page) => {
    const asked = pending.get(page.id);
    if (asked === undefined || sameTurn(asked, page.turn)) return [];
    return [{ pageId: page.id, turn: asked }];
  });
}

// 🔒 A file nobody has counted the pages of is held as **one** entry standing for the whole of it
// (docs/03 §3.3.17, ADR-025). It occupies one position and an insert lands before it or after it,
// never inside — and there is no page of it to render, to turn or to crop, because nothing yet says
// how many there are. The strip draws that state rather than pretending to know a page it does not.
export function standsForWholeFile(page: DocumentPageDto): boolean {
  return page.pageIndex === null;
}

// Whether a page has a picture the strip can draw. An image is one page and its own bytes are it; a
// counted page of a file has a thumbnail of its own; the entry above has neither.
export function hasPicture(page: DocumentPageDto, file: DocumentFileDto | undefined): boolean {
  if (file === undefined) return false;
  return file.isImage || !standsForWholeFile(page);
}

// Whether this page may be turned. Every page that can be drawn can be turned — a turn is written on
// the entry, not on the bytes (docs/03 §3.3.17) — and the one that cannot be drawn cannot, since
// there is no page there yet to stand any particular way up.
export function canTurn(page: DocumentPageDto, file: DocumentFileDto | undefined): boolean {
  return hasPicture(page, file);
}

// Whether this page may be cropped. The same rule, for the same reason: the crop editor drags four
// corners over a picture, and a file nobody has opened has none to drag them over. 🔒 A **mirror**
// is a different question and is asked of the file — a PDF page arrives the way its producer laid
// it out, so it turns in quarters and is never reflected (docs/11 §11.5c).
export function canCrop(page: DocumentPageDto, file: DocumentFileDto | undefined): boolean {
  return hasPicture(page, file);
}

export function canMirror(file: DocumentFileDto | undefined): boolean {
  return file?.isImage ?? false;
}
