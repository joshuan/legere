import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  MAX_BINARY_BYTES,
  chunkToBuffer,
  readBoundedBody,
  readBoundedJson,
  readBoundedText,
  toBuffer,
} from './binary-source';

// A body that never ends: one chunk of `chunkBytes` after another, for ever. `arrayBuffer()` on this
// never returns and grows without limit, which is the whole point of the bound being tested.
function endlessResponse(chunkBytes = 64 * 1024): { response: Response; produced: () => number } {
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  });
  return { response: new Response(body), produced: () => chunks };
}

// The same for a Node stream: an infinite generator, so a `toBuffer` without a cap would run until
// the process died.
function endlessStream(chunkBytes = 64 * 1024): { stream: Readable; produced: () => number } {
  let chunks = 0;
  function* forever(): Generator<Buffer> {
    for (;;) {
      chunks += 1;
      yield Buffer.alloc(chunkBytes);
    }
  }
  return { stream: Readable.from(forever()), produced: () => chunks };
}

describe('chunkToBuffer', () => {
  it('hands a Buffer straight back, so nothing is copied on the common path', () => {
    const buffer = Buffer.from('%PDF-1.7');
    expect(chunkToBuffer(buffer)).toBe(buffer);
  });

  it('keeps the bytes of a Uint8Array chunk instead of their decimal spelling', () => {
    // 🔒 The bug this replaced: `String(new Uint8Array([37, 80, 68, 70]))` is "37,80,68,70", so a
    // chunk arriving as a plain typed array became eleven ASCII characters where four bytes were.
    // A file hashed through that has the hash of the text, and its magic bytes are gone.
    expect(chunkToBuffer(new Uint8Array([37, 80, 68, 70]))).toEqual(Buffer.from('%PDF'));
  });

  it('reads a typed array that is a window onto a larger buffer, not the whole of it', () => {
    const underlying = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const window = underlying.subarray(2, 4);
    expect(chunkToBuffer(window)).toEqual(Buffer.from([3, 4]));
  });

  it('reads an ArrayBuffer and a string chunk, which is what an encoded stream yields', () => {
    expect(chunkToBuffer(Uint8Array.from([7, 8]).buffer)).toEqual(Buffer.from([7, 8]));
    expect(chunkToBuffer('héllo')).toEqual(Buffer.from('héllo', 'utf8'));
  });

  it('refuses a chunk that is not bytes rather than coercing it into plausible nonsense', () => {
    expect(() => chunkToBuffer({ nowhere: 'near bytes' })).toThrow(/not bytes/);
    expect(() => chunkToBuffer(null)).toThrow(/not bytes/);
  });
});

describe('toBuffer', () => {
  it('hands a Buffer back as it is', async () => {
    const buffer = Buffer.from('already bytes');
    expect(await toBuffer(buffer)).toBe(buffer);
  });

  it('refuses a Buffer larger than one step may hold', async () => {
    // 🔒 The cap applies to bytes somebody else chose the size of, however they arrived.
    await expect(toBuffer(Buffer.alloc(65), 64)).rejects.toThrow(/65 bytes past a 64-byte bound/);
  });

  it('reads a stream into one buffer, in order', async () => {
    const stream = Readable.from([Buffer.from('one '), Buffer.from('two')]);
    expect((await toBuffer(stream)).toString('utf8')).toBe('one two');
  });

  it('hashes the bytes of a Uint8Array-yielding stream, not their decimal spelling', async () => {
    const stream = Readable.from([new Uint8Array([37, 80, 68, 70]), new Uint8Array([45])]);
    expect((await toBuffer(stream)).toString('utf8')).toBe('%PDF-');
  });

  it('refuses an endless stream while it streams, rather than reading it whole', async () => {
    // 🔒 Without the cap this never returns: the generator keeps producing and the buffer keeps
    // growing until the process dies — and this process is also the HTTP surface.
    const { stream, produced } = endlessStream(1024);

    await expect(toBuffer(stream, 4096)).rejects.toThrow(/past a 4096-byte bound/);
    // A handful of chunks, not five thousand: the refusal costs about one chunk's worth of memory,
    // plus whatever the stream had already read ahead into its own buffer.
    expect(produced()).toBeLessThan(16);
  });

  it('defaults to the bound a step may hold, which is well under a whole library volume', () => {
    expect(MAX_BINARY_BYTES).toBe(256 * 1024 * 1024);
  });
});

describe('readBoundedBody', () => {
  it('reads a response that fits', async () => {
    expect(await readBoundedBody(new Response('a short answer'), 1024)).toEqual(
      Buffer.from('a short answer'),
    );
  });

  it('answers with nothing when there is no body at all', async () => {
    expect(await readBoundedBody(new Response(null, { status: 204 }), 1024)).toEqual(
      Buffer.alloc(0),
    );
  });

  it('refuses an endless body at the first chunk past the bound and stops the sender', async () => {
    // 🔒 Without the bound this is `response.arrayBuffer()` against a container that never stops
    // talking: the read never returns and the process grows until it is killed.
    const { response, produced } = endlessResponse(1024);

    await expect(readBoundedBody(response, 4096)).rejects.toThrow(/past a 4096-byte bound/);
    expect(produced()).toBe(5);
    // Cancelled on the way out, so the other side is told to stop instead of filling a socket buffer.
    expect(response.bodyUsed).toBe(true);
  });
});

describe('readBoundedText and readBoundedJson', () => {
  it('read what fits', async () => {
    expect(await readBoundedText(new Response('detail'), 1024)).toBe('detail');
    expect(await readBoundedJson(Response.json({ ok: true }), 1024)).toEqual({ ok: true });
  });

  it('carry the same bound as the body underneath them', async () => {
    const { response } = endlessResponse(1024);
    await expect(readBoundedText(response, 2048)).rejects.toThrow(/past a 2048-byte bound/);

    const json = endlessResponse(1024);
    await expect(readBoundedJson(json.response, 2048)).rejects.toThrow(/past a 2048-byte bound/);
  });
});
