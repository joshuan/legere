import { Readable } from 'node:stream';
import { buffer as readToBuffer } from 'node:stream/consumers';
import {
  contentDispositionOf,
  FileStorage,
  type Delivery,
  type StoredObjectInfo,
} from '../../application/ports/file-storage';

export type StoredObject = {
  body: Buffer;
  contentType: string;
};

// The FileStorage used by unit and e2e tests (docs/09 §9.3): no bucket, no network, and the written
// bytes stay readable so a test can assert what the pipeline produced.
export class InMemoryFileStorage extends FileStorage {
  readonly objects = new Map<string, StoredObject>();

  async put(key: string, body: Readable | Buffer, contentType: string): Promise<void> {
    const bytes = Buffer.isBuffer(body) ? body : await readToBuffer(body);
    this.objects.set(key, { body: bytes, contentType });
  }

  // A missing key has to *reject* rather than throw synchronously: S3 cannot fail before its promise
  // exists, and a double that differs there hides bugs instead of finding them.
  getStream(key: string): Promise<Readable> {
    return Promise.resolve().then(() => Readable.from(this.get(key).body));
  }

  // Shaped like a presigned URL, TTL included, so assertions read the same against both
  // implementations. Signing does not require the object to exist, just as it does not on S3. The
  // delivery rides on the URL the way S3 puts it there, so a test can see what a browser would be
  // told without a bucket to ask.
  getSignedUrl(key: string, ttlSec: number, delivery: Delivery): Promise<string> {
    const query = new URLSearchParams({
      'X-Amz-Expires': String(ttlSec),
      'response-content-type': delivery.contentType,
      'response-content-disposition': contentDispositionOf(delivery),
    });
    return Promise.resolve(`http://in-memory-storage.test/${encodeURI(key)}?${query.toString()}`);
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<StoredObjectInfo[]> {
    const listed: StoredObjectInfo[] = [];
    for (const [key, stored] of this.objects) {
      if (key.startsWith(prefix)) listed.push({ key, size: stored.body.byteLength });
    }
    return Promise.resolve(listed.sort((a, b) => a.key.localeCompare(b.key)));
  }

  // Test-side reads.
  get(key: string): StoredObject {
    const stored = this.objects.get(key);
    if (stored === undefined) throw new Error(`No object at ${key}`);
    return stored;
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  clear(): void {
    this.objects.clear();
  }
}
