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
  // `delivery` is not advice: the implementation binds it into the URL, so a browser handed one gets
  // the bytes on those terms and no others (docs/09 §9.2).
  abstract getSignedUrl(key: string, ttlSec: number, delivery: Delivery): Promise<string>;

  abstract exists(key: string): Promise<boolean>;

  // Maintenance only: artifacts of soft-deleted documents are retained (docs/09 §9.2).
  abstract delete(key: string): Promise<void>;

  // Everything under a prefix, in one shot. Maintenance only (docs/09 §9.5): it is a full listing of
  // the bucket, which is why it runs hourly on a cron and not on a request path. One listing answers
  // both questions maintenance has — what is orphaned, and how much the bucket holds.
  abstract list(prefix: string): Promise<StoredObjectInfo[]>;
}

export type StoredObjectInfo = {
  key: string;
  // A single object's size always fits a JS number; totals are summed as BigInt by the caller.
  size: number;
};

// 🔒 How bytes are meant to reach a browser (docs/09 §9.2). Only the caller knows whether a key is a
// page of the document being read or somebody's upload being handed back, so it says, once, per
// request — and every route that hands bytes over states it, whether they are streamed through the
// app or fetched from the bucket by the browser itself.
//
// `inline` is rendered where it stands: the preview an <img> points at, the canonical PDF the
// viewer embeds in an <object>. `attachment` is bytes to save, and a browser renders an attachment
// as nothing at all, whatever `contentType` claims — which is why an upload is only ever that.
export type Delivery =
  | { disposition: 'inline'; contentType: string }
  // The name a saved file gets. Required rather than optional: bytes offered to be saved without a
  // name are saved under the key's last segment, which is `original.pdf` for every upload there is.
  | { disposition: 'attachment'; contentType: string; fileName: string };

// RFC 5987: a plain ASCII fallback plus the real name, so a Cyrillic title survives the trip. One
// formatter for both ways bytes leave Legere — the response header the app writes, and the override
// signed into a presigned URL — because they are one rule and must not drift apart.
export function contentDispositionOf(delivery: Delivery): string {
  if (delivery.disposition === 'inline') return 'inline';
  const ascii = delivery.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(delivery.fileName)}`;
}
