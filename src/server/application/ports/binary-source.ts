import type { Readable } from 'node:stream';

// What the processing ports accept as input. Callers hand over whatever they already hold — a stream
// straight from the library volume or from S3, or bytes produced by an earlier step — and each
// implementation materializes it as its own tooling requires (HTTP multipart, sharp, pdfjs).
export type BinarySource = Readable | Buffer;
