import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/app-config';
import { S3FileStorage } from './s3-file-storage';

// Presigning is a local computation over the request and the credentials — no bucket is contacted —
// so the URL contract of docs/09 §9.2 is covered here rather than in the MinIO integration suite.
function storage(overrides: Record<string, string> = {}): S3FileStorage {
  return new S3FileStorage(
    loadConfig({
      DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
      APP_BASE_URL: 'http://localhost:3000',
      AUTH_SECRET: 'test-secret-minimum-32-characters!!',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'legere',
      S3_ACCESS_KEY_ID: 'legere',
      S3_SECRET_ACCESS_KEY: 'legere-secret',
      ...overrides,
    }),
  );
}

describe('S3FileStorage', () => {
  describe('getSignedUrl', () => {
    it('signs a GET that expires after the requested TTL', async () => {
      const url = new URL(await storage().getSignedUrl('documents/doc-1/preview.jpg', 300));

      // The TTL is what makes the URL safe to hand to a browser (docs/09 §9.2, default 300 s).
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
      expect(url.searchParams.get('X-Amz-Credential')).toContain('legere');
    });

    it('carries the requested TTL rather than a fixed one', async () => {
      const url = new URL(await storage().getSignedUrl('documents/doc-1/thumb.jpg', 30));

      expect(url.searchParams.get('X-Amz-Expires')).toBe('30');
    });

    it('addresses the bucket path-style, as MinIO requires', async () => {
      const url = new URL(await storage().getSignedUrl('documents/doc-1/canonical.pdf', 300));

      expect(url.host).toBe('localhost:9000');
      expect(url.pathname).toBe('/legere/documents/doc-1/canonical.pdf');
    });

    it('falls back to virtual-host addressing when path style is turned off', async () => {
      const url = new URL(
        await storage({ S3_FORCE_PATH_STYLE: 'false' }).getSignedUrl(
          'documents/doc-1/thumb.jpg',
          300,
        ),
      );

      expect(url.host).toBe('legere.localhost:9000');
      expect(url.pathname).toBe('/documents/doc-1/thumb.jpg');
    });

    it('signs against the endpoint browsers use when that differs from the internal one', async () => {
      const url = new URL(
        await storage({
          S3_ENDPOINT: 'http://minio:9000',
          S3_PUBLIC_ENDPOINT: 'https://files.example.com',
        }).getSignedUrl('documents/doc-1/preview.jpg', 300),
      );

      // 🔒 The host is part of the signature: a URL signed for `minio:9000` is rejected the moment a
      // browser asks `files.example.com` for it (docs/09 §9.2).
      expect(url.origin).toBe('https://files.example.com');
      expect(url.pathname).toBe('/legere/documents/doc-1/preview.jpg');
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    });

    it('keeps signing against the only endpoint there is when no public one is set', async () => {
      const url = new URL(await storage().getSignedUrl('documents/doc-1/preview.jpg', 300));

      expect(url.origin).toBe('http://localhost:9000');
    });

    it('signs a different URL per key, so one URL never grants access to another artifact', async () => {
      const files = storage();
      const [preview, thumb] = await Promise.all([
        files.getSignedUrl('documents/doc-1/preview.jpg', 300),
        files.getSignedUrl('documents/doc-2/preview.jpg', 300),
      ]);

      expect(new URL(preview).searchParams.get('X-Amz-Signature')).not.toBe(
        new URL(thumb).searchParams.get('X-Amz-Signature'),
      );
    });
  });
});
