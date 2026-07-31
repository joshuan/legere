import { buffer as readToBuffer } from 'node:stream/consumers';
import type { BinarySource } from '../../application/ports/binary-source';

// Every tool behind the PDF ports needs the whole input in memory: Stirling receives it as a
// multipart part with a length, sharp and pdfjs both work on a complete buffer. Materializing here
// keeps that requirement out of the port contract, which callers satisfy with whatever they hold.
export function toBuffer(source: BinarySource): Promise<Buffer> {
  return Buffer.isBuffer(source) ? Promise.resolve(source) : readToBuffer(source);
}
