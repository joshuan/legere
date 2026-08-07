import { describe, expect, it } from 'vitest';
import type { Delivery } from '../../application/ports/file-storage';
import { loadConfig } from '../config/app-config';
import { S3FileStorage } from './s3-file-storage';

// How the artifacts the page renders itself are asked for, and how everything a person uploaded is.
const INLINE_JPEG: Delivery = { disposition: 'inline', contentType: 'image/jpeg' };
const INLINE_PDF: Delivery = { disposition: 'inline', contentType: 'application/pdf' };
const SAVED_UPLOAD: Delivery = {
  disposition: 'attachment',
  contentType: 'application/octet-stream',
  fileName: 'report.html',
};

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
      const url = new URL(
        await storage().getSignedUrl('documents/doc-1/preview.jpg', 300, INLINE_JPEG),
      );

      // The TTL is what makes the URL safe to hand to a browser (docs/09 §9.2, default 300 s).
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
      expect(url.searchParams.get('X-Amz-Credential')).toContain('legere');
    });

    it('carries the requested TTL rather than a fixed one', async () => {
      const url = new URL(
        await storage().getSignedUrl('documents/doc-1/thumb.jpg', 30, INLINE_JPEG),
      );

      expect(url.searchParams.get('X-Amz-Expires')).toBe('30');
    });

    it('addresses the bucket path-style, as MinIO requires', async () => {
      const url = new URL(
        await storage().getSignedUrl('documents/doc-1/canonical.pdf', 300, INLINE_PDF),
      );

      expect(url.host).toBe('localhost:9000');
      expect(url.pathname).toBe('/legere/documents/doc-1/canonical.pdf');
    });

    it('falls back to virtual-host addressing when path style is turned off', async () => {
      const url = new URL(
        await storage({ S3_FORCE_PATH_STYLE: 'false' }).getSignedUrl(
          'documents/doc-1/thumb.jpg',
          300,
          INLINE_JPEG,
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
        }).getSignedUrl('documents/doc-1/preview.jpg', 300, INLINE_JPEG),
      );

      // 🔒 The host is part of the signature: a URL signed for `minio:9000` is rejected the moment a
      // browser asks `files.example.com` for it (docs/09 §9.2).
      expect(url.origin).toBe('https://files.example.com');
      expect(url.pathname).toBe('/legere/documents/doc-1/preview.jpg');
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    });

    it('keeps signing against the only endpoint there is when no public one is set', async () => {
      const url = new URL(
        await storage().getSignedUrl('documents/doc-1/preview.jpg', 300, INLINE_JPEG),
      );

      expect(url.origin).toBe('http://localhost:9000');
    });

    it('signs a different URL per key, so one URL never grants access to another artifact', async () => {
      const files = storage();
      const [preview, thumb] = await Promise.all([
        files.getSignedUrl('documents/doc-1/preview.jpg', 300, INLINE_JPEG),
        files.getSignedUrl('documents/doc-2/preview.jpg', 300, INLINE_JPEG),
      ]);

      expect(new URL(preview).searchParams.get('X-Amz-Signature')).not.toBe(
        new URL(thumb).searchParams.get('X-Amz-Signature'),
      );
    });

    // 🔒 SEC-03. The bucket answers on the terms written into the URL, not on the terms the object
    // was stored under — so an upload the detector believed was a page still comes back as bytes to
    // save, including every object written before this rule existed (docs/09 §9.2).
    it('overrides what the object claims to be with what the caller says it may be served as', async () => {
      const url = new URL(
        await storage().getSignedUrl('files/file-1/original.html', 300, SAVED_UPLOAD),
      );

      expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
      expect(url.searchParams.get('response-content-disposition')).toContain('attachment');
    });

    it('names a saved file as it arrived, ASCII fallback and all', async () => {
      const url = new URL(
        await storage().getSignedUrl('files/file-1/original.pdf', 300, {
          disposition: 'attachment',
          contentType: 'application/pdf',
          fileName: 'Счёт за январь.pdf',
        }),
      );

      const disposition = url.searchParams.get('response-content-disposition') ?? '';
      expect(disposition).toContain("filename*=UTF-8''");
      expect(disposition).toContain(encodeURIComponent('Счёт за январь.pdf'));
      const plain = /filename="([^"]*)"/.exec(disposition)?.[1] ?? '';
      expect(/^[\x20-\x7e]*$/.test(plain)).toBe(true);
    });

    it('lets the artifacts the page renders itself keep their own type, inline', async () => {
      const [preview, canonical] = await Promise.all([
        storage().getSignedUrl('documents/doc-1/preview.jpg', 300, INLINE_JPEG),
        storage().getSignedUrl('documents/doc-1/canonical.pdf', 300, INLINE_PDF),
      ]);

      // The viewer embeds the canonical in an <object> and the grid points an <img> at the preview:
      // both have to render where they stand (docs/11 §11.5b).
      expect(new URL(preview).searchParams.get('response-content-type')).toBe('image/jpeg');
      expect(new URL(preview).searchParams.get('response-content-disposition')).toBe('inline');
      expect(new URL(canonical).searchParams.get('response-content-type')).toBe('application/pdf');
      expect(new URL(canonical).searchParams.get('response-content-disposition')).toBe('inline');
    });

    it('signs the overrides, so a URL edited to soften them no longer verifies', async () => {
      const url = new URL(
        await storage().getSignedUrl('files/file-1/original.html', 300, SAVED_UPLOAD),
      );
      const signed = url.searchParams.get('X-Amz-Signature');

      // 🔒 Editing the response headers is editing the request: the same key signed to be rendered
      // instead of saved is a different signature, so the edited URL is refused rather than served.
      const rendered = new URL(
        await storage().getSignedUrl('files/file-1/original.html', 300, {
          disposition: 'inline',
          contentType: 'text/html',
        }),
      );

      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
      expect(rendered.searchParams.get('X-Amz-Signature')).not.toBe(signed);
    });
  });
});
