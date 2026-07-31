import type { Readable } from 'node:stream';
import { buffer as readToBuffer } from 'node:stream/consumers';

// What the processing ports accept as input. Callers hand over whatever they already hold — a stream
// straight from the library volume or from S3, or bytes produced by an earlier step — and each
// implementation materializes it as its own tooling requires (HTTP multipart, sharp, pdfjs).
export type BinarySource = Readable | Buffer;

// A stream can be read exactly once, so anything that feeds the same bytes to two operations has to
// materialize them first.
export function toBuffer(source: BinarySource): Promise<Buffer> {
  return Buffer.isBuffer(source) ? Promise.resolve(source) : readToBuffer(source);
}
