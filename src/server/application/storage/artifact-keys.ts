import type { Delivery } from '../ports/file-storage';

// The S3 key layout (docs/09 §9.2), and — below — what an object stored there may claim to be on its
// way back out. A document's artifacts are deterministic from its id; a managed file's own bytes are
// addressed by the file id and the key is recorded on the row, so a key written by an older version
// keeps resolving. Every producer and consumer goes through these helpers, so the layout is stated
// once.
export const artifactKeys = {
  // Canonicalized PDF: every document has one, built from its files (docs/05 §5.5).
  canonicalPdf: (documentId: string): string => `documents/${documentId}/canonical.pdf`,
  // First page, PREVIEW_MAX_DIM.
  preview: (documentId: string): string => `documents/${documentId}/preview.jpg`,
  // First page, THUMB_MAX_DIM.
  thumbnail: (documentId: string): string => `documents/${documentId}/thumb.jpg`,
  // A MANAGED file's own bytes: an upload, or something we made (docs/09 §9.2). A LIBRARY file has
  // no object at all — its bytes stay on the volume.
  fileOriginal: (fileId: string, ext: string): string =>
    `files/${fileId}/original.${ext === '' ? 'bin' : ext}`,
  // One page of a file's own original, rendered small (docs/09 §9.2). 0-based, the way a page order
  // counts (docs/03 §3.3.16). Written once and then simply there: the bytes it was drawn from are
  // immutable, so page 3 of a file is the same picture for ever. A LIBRARY file has these even
  // though it has no original here — the layout is by file, not by where the file's own bytes live.
  filePageThumb: (fileId: string, page: number): string => `files/${fileId}/pages/${page}.jpg`,
  // Everything belonging to one document, for maintenance sweeps.
  documentPrefix: (documentId: string): string => `documents/${documentId}/`,
  // The same for one file.
  filePrefix: (fileId: string): string => `files/${fileId}/`,
} as const;

// Where one managed file's bytes are: what the row recorded, or — for a row written before the key
// was known, since the key contains the id the database assigns — the layout above (docs/09 §9.2).
export function originalKeyOf(file: {
  id: string;
  ext: string;
  storageKey: string | null;
}): string {
  return file.storageKey ?? artifactKeys.fileOriginal(file.id, file.ext);
}

// 🔒 The only content types Legere is willing to say an object is. Everything else becomes bytes to
// save — because the MIME of an upload is decided by its own file name when its bytes carry no
// signature, and a browser handed `text/html` renders it as a page with a script in it (docs/09 §9.2).
// Two things have to render and nothing else does: the canonical PDF the viewer embeds, and the
// pictures the grid shows and the crop editor points an <img> at. The first is named here; the
// second is a rule rather than a list, for the reason under `isRenderable`.
//
// This is about serving, not about understanding: the detected MIME stays on the file row, and
// display, `isImageFile` and the format classification that decides how a document is converted all
// read the row and never the object (docs/03 §3.3.10, docs/05 §5.5).
const RENDERABLE_MIME_TYPES: ReadonlySet<string> = new Set(['application/pdf']);

// 🔒 SVG is a document that can carry script, so it is never served as itself — which is most of
// why this rule exists at all.
const SCRIPTABLE_IMAGE = 'image/svg+xml';

// Any other `image/*` is served as itself, and that is safe for a reason worth writing down: an
// image type only ever reaches a file row from magic-byte detection. The extension fallback in
// `FileTypeMimeDetector` produces text types and nothing else, so `image/png` means the bytes begin
// like a PNG — not that somebody named their file `.png`.
//
// Stating it this way rather than listing formats also keeps this rule and `isImageFile` from
// drifting apart. They must agree: a file the product offers to crop and points an `<img>` at, but
// serves as bytes-to-save, would simply not draw — a library original is streamed by us with
// `nosniff`, and a browser will not render a non-image type in an `<img>`.
function isRenderable(mime: string): boolean {
  if (RENDERABLE_MIME_TYPES.has(mime)) return true;
  return mime.startsWith('image/') && mime !== SCRIPTABLE_IMAGE;
}

const BYTES_TO_SAVE = 'application/octet-stream';

// Applied at both ends of an object's life: what it is written to the bucket as, and what a response
// carrying it says it is. One rule, so an object stored before the rule existed is still served
// under it.
export function servableContentType(mimeType: string): string {
  const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return isRenderable(mime) ? mime : BYTES_TO_SAVE;
}

// An original is never a page: whatever a person uploaded comes back as something to save, under the
// name it arrived with, and only a type on the allow-list above keeps its own name for it — an image
// still has to load into an <img> for the crop editor (docs/07 §7.3, docs/09 §9.2).
export function originalDelivery(file: { mimeType: string; name: string }): Delivery {
  return {
    disposition: 'attachment',
    contentType: servableContentType(file.mimeType),
    fileName: file.name,
  };
}
