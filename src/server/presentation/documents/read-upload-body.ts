import type { Request } from 'express';
import { PayloadTooLargeError, UnprocessableError } from '../../domain/errors/domain-error';

// The file name travels in a header, since the body is the file itself (docs/07 §7.3). Browsers may
// only send Latin-1 there, so the client percent-encodes it and we decode here.
export const FILENAME_HEADER = 'x-legere-filename';

// The same, for a file added to an existing document (docs/07 §7.3 "Document files").
export const ATTACHED_FILENAME_HEADER = 'x-file-name';

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
  // 🔒 Only the last segment: a name like `../../etc/passwd` must not travel anywhere as a path, and
  // nothing downstream should have to remember that.
  return decoded.replace(/^.*[\\/]/, '').slice(0, 255);
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
