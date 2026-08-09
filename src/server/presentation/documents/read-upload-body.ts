import type { Request } from 'express';
import { PayloadTooLargeError, UnprocessableError } from '../../domain/errors/domain-error';

// The file name travels in a header, since the body is the file itself (docs/07 §7.3). Browsers may
// only send Latin-1 there, so the client percent-encodes it and we decode here.
export const FILENAME_HEADER = 'x-legere-filename';

// The same, for a file added to an existing document (docs/07 §7.3 "Document files").
export const ATTACHED_FILENAME_HEADER = 'x-file-name';

// 🔒 The routes whose body **is** the file, declared here rather than at the wiring, next to the
// function every one of them calls (docs/05 §5.1a, docs/07 §7.3). Paths are relative to `/api`.
//
// No body parser may touch these: `express.urlencoded` swallows the stream whole — curl with no
// explicit `Content-Type` sends exactly that, and `Content-Type: application/json` does the same
// through `express.json` — leaving the handler an empty request, and body-parser's own 1 MiB limit
// answers 500 long before `UPLOAD_MAX_BYTES` answers 413. The wiring used to test `path ===
// '/documents'`, which quietly covered the first of these two and not the second: uploading a file
// worked, attaching the same file to a document did not, and nothing said why. One list, so adding a
// third raw-body route is a line here rather than a bug that surfaces months later.
const RAW_BODY_ROUTES: readonly { method: string; path: RegExp }[] = [
  // POST /api/documents — a new document from an uploaded file.
  { method: 'POST', path: /^\/documents\/?$/ },
  // POST /api/documents/:id/files — another file for a document that exists.
  { method: 'POST', path: /^\/documents\/[^/]+\/files\/?$/ },
];

export function isRawBodyRoute(method: string, path: string): boolean {
  return RAW_BODY_ROUTES.some((route) => route.method === method && route.path.test(path));
}

// Reads the request body into memory, refusing anything over the cap **while it streams** rather
// than after: a 500 MiB upload to a 100 MiB instance costs one buffer's worth of memory and a closed
// socket, not half a gigabyte of it (docs/05 §5.1a).
export async function readUploadBody(req: Request, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > maxBytes) {
      // Stop reading, but do not destroy the socket: the client has to be able to read the 413 we
      // are about to send, and a reset connection reads as "server crashed" instead of "too large".
      // Node closes the connection once the response goes out with the body unread.
      req.pause();
      req.unpipe();
      throw new PayloadTooLargeError(
        `This instance accepts uploads up to ${maxBytes} bytes (UPLOAD_MAX_BYTES)`,
      );
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

// A name is required: it becomes the document's title and decides the extension when the content has
// no magic bytes of its own.
export function uploadFileName(req: Request): string {
  return fileNameFrom(req, FILENAME_HEADER);
}

// The name of a file added to a document (docs/07 §7.3). It names the file rather than the document
// — the document already has a title — and travels in a header of its own.
export function attachedFileName(req: Request): string {
  return fileNameFrom(req, ATTACHED_FILENAME_HEADER);
}

function fileNameFrom(req: Request, header: string): string {
  const raw = req.headers[header];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') {
    throw new UnprocessableError('VALIDATION_FAILED', `Missing ${header} header`);
  }

  // Percent-encoded by the client; a name that is not encoded at all decodes to itself.
  const decoded = decodeSafely(value.trim());
  // 🔒 Control characters go first, and that order is the whole point: `.` in a JavaScript regular
  // expression does not match a newline, so `%0A../../x` survived a strip that reads as if it could
  // not. What came out still carried `..` and a separator, into a document title and into another
  // container's multipart part.
  // The rule guards against a control character reaching a pattern by accident; naming them is
  // the entire point of this one.
  // eslint-disable-next-line no-control-regex
  const printable = decoded.replace(/[\u0000-\u001f\u007f]/g, '');
  // 🔒 Then only the last segment: a name like `../../etc/passwd` must not travel anywhere as a
  // path, and nothing downstream should have to remember that.
  const segments = printable.split(/[\\/]/);
  return (segments[segments.length - 1] ?? '').slice(0, 255);
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
