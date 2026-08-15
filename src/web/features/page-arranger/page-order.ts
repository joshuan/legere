import type { DocumentFileDto } from '../../../shared/contracts/documents';

// The arithmetic of a page order (docs/03 §3.3.16, docs/11 §11.5a), kept out of the component so
// that "is this row worth a strip at all" and "where does this page land" are answerable without
// rendering anything.

// The pages of a file as they arrived: 0, 1, 2 … — which is what `pageOrder: null` means.
export function naturalOrder(pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_, index) => index);
}

// Whether an order says nothing the file did not already say.
export function isNaturalOrder(order: readonly number[]): boolean {
  return order.every((page, index) => page === index);
}

export function sameOrder(one: readonly number[], other: readonly number[]): boolean {
  return one.length === other.length && one.every((page, index) => page === other[index]);
}

// The same test the server makes before it accepts an order (docs/07 §7.3): the media type, with
// whatever parameters a scanner appended to it stripped off.
function isPdf(file: Pick<DocumentFileDto, 'mimeType'>): boolean {
  return file.mimeType.split(';')[0]?.trim().toLowerCase() === 'application/pdf';
}

// 🔒 Whether this row has pages to arrange at all (docs/11 §11.5a). A photograph has none, and a
// file whose pages no build has counted has none anybody can name — the contract refuses an order
// for it (docs/07 §7.3), so offering one would be a control that only ever fails. One page is not an
// order either: a strip with a single thumbnail in it teaches the eye to skip the row.
export function hasArrangeablePages(
  file: Pick<DocumentFileDto, 'mimeType' | 'pageCount'>,
): boolean {
  return isPdf(file) && file.pageCount !== null && file.pageCount > 1;
}

// Whether somebody has been through this file's pages — which is what the row's tag says, on the
// same terms as the crop's (docs/11 §11.5a). A stored order that happens to be the natural one is
// not a rearrangement: the pages read exactly as they arrived.
export function isRearranged(file: Pick<DocumentFileDto, 'pageOrder'>): boolean {
  return file.pageOrder !== null && !isNaturalOrder(file.pageOrder);
}

// One page taken out of the order and put back at `to`, the rest closing up behind it — the whole of
// what both the drag and the arrow keys do. Positions outside the strip are refused rather than
// clamped: a page at the end asked to move further right stays where it is.
export function movePage(order: readonly number[], from: number, to: number): number[] {
  const moved = order[from];
  if (moved === undefined || to === from || to < 0 || to >= order.length) return [...order];
  const rest = order.filter((_, index) => index !== from);
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
}
