// Opaque cursors for keyset pagination (docs/07 §7.1). A cursor encodes the sort key of the last
// item returned — a timestamp plus the row id as a tiebreak, since timestamps collide. Base64url so
// it survives a query string; opaque to clients, which must only echo it back.
export type Cursor = { at: Date; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at.toISOString()}|${cursor.id}`).toString('base64url');
}

// A malformed cursor decodes to null and the caller starts from the beginning rather than erroring:
// cursors are opaque, so a client cannot reasonably repair one.
export function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined || value === '') return null;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  if (separator <= 0) return null;

  const at = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(at.getTime()) || id === '') return null;
  return { at, id };
}

// Some pages are ordered by a string rather than a timestamp (browse sorts documents by title,
// docs/07 §7.3). Same shape, same opacity — the sort key just happens to be text.
export type TextCursor = { key: string; id: string };

export function encodeTextCursor(cursor: TextCursor): string {
  return Buffer.from(`${cursor.key}\u0000${cursor.id}`).toString('base64url');
}

export function decodeTextCursor(value: string | undefined): TextCursor | null {
  if (value === undefined || value === '') return null;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('\u0000');
  if (separator < 0) return null;

  const id = decoded.slice(separator + 1);
  return id === '' ? null : { key: decoded.slice(0, separator), id };
}
