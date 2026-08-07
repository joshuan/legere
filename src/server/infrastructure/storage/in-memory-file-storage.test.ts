import { Readable } from 'node:stream';
import { buffer as readToBuffer } from 'node:stream/consumers';
import { beforeEach, describe, expect, it } from 'vitest';
import { artifactKeys } from '../../application/storage/artifact-keys';
import { InMemoryFileStorage } from './in-memory-file-storage';

// The test double has to behave like S3FileStorage for the tests that use it to mean anything
// (docs/09 §9.3): overwrite on put, absent means absent, delete is idempotent.
describe('InMemoryFileStorage', () => {
  const key = artifactKeys.preview('doc-1');
  let files: InMemoryFileStorage;

  beforeEach(() => {
    files = new InMemoryFileStorage();
  });

  it('stores a buffer and reads it back with its content type', async () => {
    await files.put(key, Buffer.from('jpeg-bytes'), 'image/jpeg');

    expect(await files.exists(key)).toBe(true);
    expect(files.get(key).contentType).toBe('image/jpeg');
    expect((await readToBuffer(await files.getStream(key))).toString()).toBe('jpeg-bytes');
  });

  it('drains a stream body before storing it', async () => {
    await files.put(key, Readable.from([Buffer.from('one '), Buffer.from('two')]), 'image/jpeg');

    expect(files.get(key).body.toString()).toBe('one two');
  });

  it('overwrites on re-put, the way a reprocess rewrites its artifact', async () => {
    await files.put(key, Buffer.from('first'), 'image/jpeg');
    await files.put(key, Buffer.from('second'), 'image/jpeg');

    expect(files.keys()).toEqual([key]);
    expect(files.get(key).body.toString()).toBe('second');
  });

  it('reports a missing key as absent and fails to stream it', async () => {
    expect(await files.exists(key)).toBe(false);
    await expect(files.getStream(key)).rejects.toThrow(key);
  });

  it('deletes, and deleting again is not an error', async () => {
    await files.put(key, Buffer.from('x'), 'image/jpeg');

    await files.delete(key);
    await files.delete(key);
    expect(await files.exists(key)).toBe(false);
  });

  it('hands out a URL carrying the TTL', async () => {
    const url = new URL(
      await files.getSignedUrl(key, 300, { disposition: 'inline', contentType: 'image/jpeg' }),
    );

    expect(url.pathname).toBe(`/${key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('carries the delivery on the URL the way a presigned one does', async () => {
    const url = new URL(
      await files.getSignedUrl(key, 300, {
        disposition: 'attachment',
        contentType: 'application/octet-stream',
        fileName: 'report.html',
      }),
    );

    expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(url.searchParams.get('response-content-disposition')).toContain('attachment');
  });
});
