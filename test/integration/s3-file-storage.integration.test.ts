import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer as readToBuffer } from 'node:stream/consumers';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { artifactKeys } from '../../src/server/application/storage/artifact-keys';
import { loadConfig } from '../../src/server/infrastructure/config/app-config';
import { S3FileStorage } from '../../src/server/infrastructure/storage/s3-file-storage';

const config = loadConfig(process.env);
const ENDPOINT = config.get('S3_ENDPOINT');
const BUCKET = config.get('S3_BUCKET');

// The suite needs the MinIO from `npm run dev:up` (docs/09 §9.4). CI has no object storage, so each
// test skips itself when nothing answers on the endpoint rather than failing the build (docs/14
// §14.8: "S3FileStorage against MinIO (local; optional in CI)"). The probe cannot run at module
// level — the server compiles to CommonJS, where top-level await does not exist — so it runs in
// beforeAll and every test consults the result.
const minio = { up: false };

function itWithMinio(name: string, body: () => Promise<void>, timeoutMs?: number): void {
  it(
    name,
    async (ctx: TestContext) => {
      if (!minio.up) ctx.skip(`no object storage on ${ENDPOINT} — run \`npm run dev:up\``);
      await body();
    },
    timeoutMs,
  );
}

describe('S3FileStorage (integration, MinIO)', () => {
  // Every run writes under its own document id, so a suite never disturbs the dev bucket's contents.
  const documentId = `test-${randomUUID()}`;
  const previewKey = artifactKeys.preview(documentId);
  const canonicalKey = artifactKeys.canonicalPdf(documentId);

  const client = new S3Client({
    endpoint: ENDPOINT,
    region: config.get('S3_REGION'),
    forcePathStyle: config.get('S3_FORCE_PATH_STYLE'),
    credentials: {
      accessKeyId: config.get('S3_ACCESS_KEY_ID'),
      secretAccessKey: config.get('S3_SECRET_ACCESS_KEY'),
    },
  });
  const files = new S3FileStorage(config);

  beforeAll(async () => {
    minio.up = await reachable(`${ENDPOINT}/minio/health/live`);
    if (!minio.up) return;
    // compose creates the bucket; a bare MinIO may not have it yet.
    await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
  });

  afterAll(async () => {
    for (const key of [previewKey, canonicalKey]) {
      await client
        .send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
        .catch(() => undefined);
    }
    client.destroy();
  });

  itWithMinio(
    'puts a small body as a single upload and streams it back byte-for-byte',
    async () => {
      await files.put(previewKey, Buffer.from('preview-bytes'), 'image/jpeg');

      expect(await files.exists(previewKey)).toBe(true);
      expect((await readToBuffer(await files.getStream(previewKey))).toString()).toBe(
        'preview-bytes',
      );

      const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: previewKey }));
      expect(head.ContentType).toBe('image/jpeg');
      // A single PutObject leaves a plain MD5 ETag; multipart appends "-<partCount>".
      expect(head.ETag).not.toMatch(/-\d+"$/);
    },
  );

  itWithMinio('overwrites on re-put, the way a reprocess rewrites its artifact', async () => {
    await files.put(previewKey, Buffer.from('rewritten'), 'image/jpeg');

    expect((await readToBuffer(await files.getStream(previewKey))).toString()).toBe('rewritten');
  });

  itWithMinio(
    'uploads a body over 8 MiB in parts',
    async () => {
      const megabyte = Buffer.alloc(1024 * 1024, 0x41);
      const chunks = Array.from({ length: 9 }, () => megabyte);

      await files.put(canonicalKey, Readable.from(chunks), 'application/pdf');

      const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: canonicalKey }));
      expect(Number(head.ContentLength)).toBe(9 * 1024 * 1024);
      // 9 MiB over 8 MiB parts — the multipart path of docs/09 §9.2, not one giant PutObject.
      expect(head.ETag).toMatch(/-2"$/);

      const readBack = await readToBuffer(await files.getStream(canonicalKey));
      expect(readBack.length).toBe(9 * 1024 * 1024);
      expect(readBack.subarray(0, 4).toString()).toBe('AAAA');
    },
    30_000,
  );

  itWithMinio('serves a presigned URL to a client that carries no credentials', async () => {
    const url = await files.getSignedUrl(previewKey, 300);

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('rewritten');
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('300');
  });

  itWithMinio(
    'rejects the same URL once its TTL has passed',
    async () => {
      const url = await files.getSignedUrl(previewKey, 1);
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const response = await fetch(url);
      // 🔒 The TTL is the whole reason it is safe to hand these URLs out (docs/09 §9.2).
      expect(response.status).toBe(403);
    },
    15_000,
  );

  itWithMinio('refuses an unsigned request for a private object', async () => {
    const response = await fetch(`${ENDPOINT}/${BUCKET}/${previewKey}`);

    // 🔒 The bucket is private: no anonymous read, no public ACL (docs/09 §9.2).
    expect(response.status).toBe(403);
  });

  itWithMinio('reports a missing key as absent instead of failing', async () => {
    expect(await files.exists(artifactKeys.thumbnail(documentId))).toBe(false);
  });

  itWithMinio('fails to stream a key that does not exist', async () => {
    await expect(files.getStream(artifactKeys.thumbnail(documentId))).rejects.toThrow();
  });

  itWithMinio('deletes an object, and deleting again is not an error', async () => {
    await files.put(artifactKeys.thumbnail(documentId), Buffer.from('thumb'), 'image/jpeg');

    await files.delete(artifactKeys.thumbnail(documentId));
    await files.delete(artifactKeys.thumbnail(documentId));
    expect(await files.exists(artifactKeys.thumbnail(documentId))).toBe(false);
  });
});

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}
