import type { Readable } from 'node:stream';

// Everything Legere produces lives in one private S3 bucket (docs/09 §9.2–9.3); the library volume
// stays read-only and is reached through LibraryReader instead. Clients never talk to the bucket
// directly: the app writes, and hands out short-lived signed URLs for reading.
export abstract class FileStorage {
  // Overwrites whatever is at the key — artifacts are rewritten idempotently on reprocess.
  abstract put(key: string, body: Readable | Buffer, contentType: string): Promise<void>;

  // Pipeline-internal reads (e.g. OCR fetching canonical.pdf). Rejects when the key does not exist.
  abstract getStream(key: string): Promise<Readable>;

  // A presigned GET URL, valid for ttlSec. Issued only after the caller passed the access check.
  abstract getSignedUrl(key: string, ttlSec: number): Promise<string>;

  abstract exists(key: string): Promise<boolean>;

  // Maintenance only: artifacts of soft-deleted documents are retained (docs/09 §9.2).
  abstract delete(key: string): Promise<void>;
}
