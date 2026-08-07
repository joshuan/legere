import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import {
  contentDispositionOf,
  FileStorage,
  type Delivery,
  type StoredObjectInfo,
} from '../../application/ports/file-storage';
import { AppConfig } from '../config/app-config';

// Bodies above this go up as a multipart upload, smaller ones as a single PutObject — the `Upload`
// helper picks per body (docs/09 §9.2). Also the size of each part and therefore of the buffer the
// helper holds per in-flight part, hence the modest concurrency below.
const PART_SIZE_BYTES = 8 * 1024 * 1024;
const PART_CONCURRENCY = 4;

@Injectable()
export class S3FileStorage extends FileStorage {
  private readonly client: S3Client;
  // Signs the URLs clients follow. The same client unless S3_PUBLIC_ENDPOINT says the bucket answers
  // on a different name outside the server's network: the host is part of what gets signed, so a URL
  // signed for `minio:9000` is rejected when a browser asks `localhost:9000` for it (docs/09 §9.2).
  private readonly presigner: S3Client;
  private readonly bucket: string;

  constructor(config: AppConfig) {
    super();
    this.bucket = config.get('S3_BUCKET');
    const options = {
      region: config.get('S3_REGION'),
      // MinIO serves buckets as a path segment; virtual-host style would need per-bucket DNS.
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE'),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY_ID'),
        secretAccessKey: config.get('S3_SECRET_ACCESS_KEY'),
      },
    };
    const publicEndpoint = config.get('S3_PUBLIC_ENDPOINT');
    this.client = new S3Client({ ...options, endpoint: config.get('S3_ENDPOINT') });
    this.presigner =
      publicEndpoint === '' ? this.client : new S3Client({ ...options, endpoint: publicEndpoint });
  }

  async put(key: string, body: Readable | Buffer, contentType: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType },
      partSize: PART_SIZE_BYTES,
      queueSize: PART_CONCURRENCY,
      // A failed multipart upload leaves no parts behind to be paid for and swept later.
      leavePartsOnError: false,
    });
    await upload.done();
  }

  async getStream(key: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    // On Node the SDK always yields a Readable; the union covers browser runtimes we never run in.
    if (!(response.Body instanceof Readable)) {
      throw new Error(`S3 returned a non-stream body for ${key}`);
    }
    return response.Body;
  }

  getSignedUrl(key: string, ttlSec: number, delivery: Delivery): Promise<string> {
    return presign(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // 🔒 What the object was written as does not decide what the bucket answers with: these two
        // overrides replace its stored `Content-Type` and `Content-Disposition` for this URL, and
        // they are part of what is signed — strip or edit either and the signature no longer
        // matches, so the request is refused rather than served on softer terms (docs/09 §9.2).
        // Being on the URL rather than on the object, this covers everything already in the bucket.
        ResponseContentType: delivery.contentType,
        ResponseContentDisposition: contentDispositionOf(delivery),
      }),
      { expiresIn: ttlSec },
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      // A missing object is an answer, not a failure; anything else (network, credentials, policy)
      // must surface so the job retries instead of silently re-deriving the artifact.
      if (httpStatusOf(error) === 404) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  // ListObjectsV2 pages through the prefix (docs/09 §9.5), 1000 keys at a time. Keys without a name
  // or a size cannot happen on a real bucket, but the SDK types them optional, so they are skipped
  // rather than asserted away.
  async list(prefix: string): Promise<StoredObjectInfo[]> {
    const objects: StoredObjectInfo[] = [];
    let token: string | undefined;

    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ...(prefix === '' ? {} : { Prefix: prefix }),
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key === undefined) continue;
        objects.push({ key: object.Key, size: object.Size ?? 0 });
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);

    return objects;
  }
}

// SDK errors carry the HTTP status in $metadata; read it without asserting a shape onto the error.
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return undefined;
  const metadata = error.$metadata;
  if (typeof metadata !== 'object' || metadata === null || !('httpStatusCode' in metadata)) {
    return undefined;
  }
  const status = metadata.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}
