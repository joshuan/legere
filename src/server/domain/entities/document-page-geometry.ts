import type { PageFormat } from '../../../shared/contracts/enums';

// What shape the pages of the canonical take, and — the part that turned out to matter — *when* that
// shape is applied (docs/05 §5.5 step 1).
//
// A photograph is rarely the shape of the sheet it is laid on. Fitted onto a portrait A4 it keeps
// its proportion and gains white bands, which looks like a cosmetic complaint and is not one:
// tesseract thresholds a page as a whole, the bands take over the histogram, and the paper's own
// grey goes to the wrong side of the threshold together with every letter on it. Measured on a
// landscape photograph of an A4 page: zero characters from the whole sheet, six hundred and
// forty-nine from the same pixels with the bands cropped away.
//
// So the page is built in the shape of what it was made from, recognised there, and only then given
// its final format. The text layer is vector and survives being scaled, which is what makes "a
// strictly A4 archive" and "a searchable archive" the same archive rather than a choice between two.

// The ratio every ISO 216 sheet has, portrait or landscape: A4, A5, A3 are all this.
export const ISO_RATIO = Math.SQRT2;

// How far from that a source may sit and still be called a sheet. ±8% spans 1.30…1.53, which holds
// the A series, a scan with a little skew, and the 3:2 and 4:3 a camera produces when somebody
// photographs a page edge to edge. Outside it lie the shapes that are not sheets at all — a receipt,
// a panorama, a square — and forcing those onto A4 is what leaves two thirds of the paper empty.
export const ISO_RATIO_TOLERANCE = 0.08;

export type SourceShape = { width: number; height: number };

// The named size a page is normalised to once it has been read, or `null` for "leave it as it was
// built". Only the sizes the converter names can be asked for; a shape that is not one of them keeps
// its own, which is exactly what MATCH_SOURCE wants anyway.
export type PageGeometry = {
  pageSize: 'A4' | null;
  orientation: 'PORTRAIT' | 'LANDSCAPE';
};

export function isSheetShaped(shape: SourceShape): boolean {
  if (shape.width <= 0 || shape.height <= 0) return false;
  const ratio = Math.max(shape.width, shape.height) / Math.min(shape.width, shape.height);
  return Math.abs(ratio - ISO_RATIO) <= ISO_RATIO * ISO_RATIO_TOLERANCE;
}

export function isLandscape(shape: SourceShape): boolean {
  return shape.width > shape.height;
}

// The document's pages, as they were built, and what the reader asked for → what the canonical ends
// up as.
//
// `AUTO` reads the shapes: a document whose pages are all sheet-shaped becomes A4 in the orientation
// they are already in — the common case, a photographed or scanned page, and the one that should
// come out looking like the paper it was. Anything else keeps what it was built from, because a
// receipt is a strip and a strip on A4 is a stamp in the middle of a sheet.
//
// Mixed shapes are read as *not* sheet-shaped: normalising them all to A4 would letterbox whichever
// of them disagreed, and the point of this whole function is that letterboxing is never free.
export function pageGeometryOf(shapes: readonly SourceShape[], format: PageFormat): PageGeometry {
  const orientation =
    shapes.length > 0 && shapes.every(isLandscape) ? ('LANDSCAPE' as const) : ('PORTRAIT' as const);

  if (format === 'MATCH_SOURCE') return { pageSize: null, orientation };
  if (format === 'A4') return { pageSize: 'A4', orientation };

  // AUTO. With nothing to read the shape of — a document made only of PDFs and office files, which
  // arrive with pages of their own — there is nothing to normalise either: those pages were laid out
  // by whoever produced them, and A4 is a guess about somebody else's document.
  if (shapes.length === 0) return { pageSize: null, orientation };

  return { pageSize: shapes.every(isSheetShaped) ? 'A4' : null, orientation };
}
