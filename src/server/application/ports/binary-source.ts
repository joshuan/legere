import type { Readable } from 'node:stream';

// What the processing ports accept as input. Callers hand over whatever they already hold — a stream
// straight from the library volume or from S3, or bytes produced by an earlier step — and each
// implementation materializes it as its own tooling requires (HTTP multipart, sharp, pdfjs).
export type BinarySource = Readable | Buffer;

// 🔒 The most bytes one step may hold whole in memory, for a file it reads or for an answer it gets
// back. The pipeline works on whole documents — hash it, convert it, upload it — so anything it
// opens is a buffer for as long as the step runs, and this process is also the HTTP surface
// (docs/02 ADR-002): a single 5 GB PDF dropped on a library volume would take the instance down with
// it, and `SCAN_MAX_FILES` bounds how many files a scan takes in, never how large one of them is
// (docs/05 §5.4).
//
// 256 MiB rather than the 100 MiB an upload may be (`UPLOAD_MAX_BYTES`): a file this instance
// accepted must still be processable, and there is room above the default for an operator who raises
// that knob. Raised past this, uploads are still accepted and their processing step fails with the
// message below — loudly, on one document, which is the direction this is meant to fail in.
export const MAX_BINARY_BYTES = 256 * 1024 * 1024;

// A stream can be read exactly once, so anything that feeds the same bytes to two operations has to
// materialize them first — under a cap, because the bytes are somebody else's and the memory is
// ours.
export async function toBuffer(
  source: BinarySource,
  maxBytes: number = MAX_BINARY_BYTES,
): Promise<Buffer> {
  if (Buffer.isBuffer(source)) {
    if (source.byteLength > maxBytes) throw tooLarge(source.byteLength, maxBytes);
    return source;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const buffer = chunkToBuffer(chunk);
    size += buffer.byteLength;
    // Refused **while** it streams, the same rule an upload follows (docs/05 §5.1a): an oversized
    // file costs one chunk's worth of memory rather than all of it. Throwing out of a `for await`
    // destroys the stream, so nothing keeps reading behind us.
    if (size > maxBytes) throw tooLarge(size, maxBytes);
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

// One chunk of a stream as bytes. A `Readable` is typed as yielding anything, and what it actually
// yields depends on how it was made: a file stream and an S3 body give Buffers, a stream built from
// a `Uint8Array` gives that, and a stream with an encoding set gives strings.
//
// The distinction matters more than it looks: `String(uint8Array)` is the comma-joined decimal
// spelling of the bytes — `"37,80,68,70"` for `%PDF` — so a chunk that arrives as a plain
// `Uint8Array` used to be silently replaced by seven times its length in ASCII digits. The hash
// would be of that text, the format detection would see no magic bytes, and nothing would say so.
// A typed array is therefore re-viewed rather than stringified, and anything genuinely unexpected is
// refused instead of being coerced into plausible-looking nonsense.
export function chunkToBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  // A view over the bytes that already exist, not a copy of them.
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  // An encoding was set on the stream, so the bytes were already decoded for us.
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  throw new Error('This stream yields something that is not bytes');
}

// 🔒 The bytes an outbound call is allowed to bring back. `response.arrayBuffer()` reads whatever the
// other side chooses to send, and a wedged — or hostile — container can send gigabytes into a process
// that is also serving pages (docs/05 §5.4). Read chunk by chunk so the refusal costs one chunk, and
// cancel on the way out so the sender is told to stop instead of filling a socket buffer.
export async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const body = response.body;
  // A 204, or a response somebody built without one: there is nothing to read and nothing to bound.
  if (body === null) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(size, maxBytes);
    }
    // A view over the chunk that already exists, not a copy of it.
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }

  return Buffer.concat(chunks);
}

// The same, for an answer that is text — an error detail, a Markdown conversion.
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  return (await readBoundedBody(response, maxBytes)).toString('utf8');
}

// The same, for an answer that is JSON. Parsing is the caller's business only in what it does with
// the result: the shape is validated by a schema wherever this is used.
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readBoundedText(response, maxBytes));
}

function tooLarge(size: number, maxBytes: number): Error {
  return new Error(
    `This is larger than one step may hold in memory: ${size} bytes past a ${maxBytes}-byte bound`,
  );
}
