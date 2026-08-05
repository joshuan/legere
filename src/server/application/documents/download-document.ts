import type { Readable } from 'node:stream';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentDetail } from '../../domain/repositories/document.repository';
import type { FileStorage } from '../ports/file-storage';
import { artifactKeys, originalKeyOf } from '../storage/artifact-keys';
import { fileOf } from './compose-document';
import type { DocumentFileBytes } from './document-file-bytes';

// Bytes reach a client one of two ways (docs/09 §9.1–9.2): what sits on the read-only volume is
// streamed through the app, and anything Legere keeps in its own bucket is handed over as a
// short-lived signed URL. There are no direct links to either.
export type Download =
  | {
      kind: 'stream';
      body: Readable;
      contentType: string;
      // Absent when nothing knows it without asking the bucket; the client then reads to the end.
      contentLength?: bigint;
      fileName: string;
    }
  | { kind: 'redirect'; url: string };

export type DownloadSettings = {
  signedUrlTtlSec: number;
};

// Which derived artifact a route is after (docs/09 §9.2).
export type ArtifactKind = 'preview' | 'thumb';

// GET /api/documents/:id/canonical (docs/07 §7.3). This **is** the document as far as reading and
// downloading go (docs/05 §5.5): one PDF in page order, whatever the originals were and whether or
// not the volume that held them is still plugged in.
export class DownloadDocumentCanonical {
  constructor(
    private readonly files: FileStorage,
    private readonly settings: DownloadSettings,
  ) {}

  async execute(detail: DocumentDetail, download: boolean): Promise<Download> {
    const { document } = detail;
    if (document.steps.canonical !== 'DONE') {
      // Honest rather than a redirect to a URL that 404s from the bucket: the PDF is being
      // assembled, and the originals are one level down in the meantime (docs/11 §11.5b).
      throw new ConflictError('CANONICAL_NOT_READY', 'The canonical PDF has not been built yet');
    }

    const key = artifactKeys.canonicalPdf(document.id);
    if (!download) {
      // Viewed rather than saved: this is what the `<embed>` on the page points at, and a signed URL
      // serves the range requests a PDF viewer makes without going through us (docs/09 §9.2).
      return {
        kind: 'redirect',
        url: await this.files.getSignedUrl(key, this.settings.signedUrlTtlSec),
      };
    }

    // Saved rather than viewed: streamed through the app, because the name the person ends up with
    // is the title of the document and only this response can say so (docs/11 §11.5b).
    return {
      kind: 'stream',
      body: await this.files.getStream(key),
      contentType: 'application/pdf',
      fileName: `${document.title}.pdf`,
    };
  }
}

// GET /api/documents/:id/files/:fileId/content (docs/07 §7.3): the original bytes of one file,
// exactly as they arrived. A library file is streamed from the volume, a managed one is a signed URL
// into our own bucket (docs/09 §9.1–9.2).
export class DownloadDocumentFile {
  constructor(
    private readonly bytes: DocumentFileBytes,
    private readonly files: FileStorage,
    private readonly settings: DownloadSettings,
  ) {}

  async execute(detail: DocumentDetail, fileId: string): Promise<Download> {
    const file = fileOf(detail, fileId);

    if (file.origin === 'MANAGED') {
      return {
        kind: 'redirect',
        url: await this.files.getSignedUrl(originalKeyOf(file), this.settings.signedUrlTtlSec),
      };
    }

    return {
      kind: 'stream',
      body: await this.bytes.open(file),
      contentType: file.mimeType,
      contentLength: file.sizeBytes,
      // The original, named as it arrived (docs/11 §11.5b) — not after the document, which may be
      // made of forty of these.
      fileName: file.name,
    };
  }
}

// preview.jpg / thumb.jpg as a signed URL (docs/09 §9.2). A step that never produced its artifact is
// a 404: there is nothing to hand out, and pretending otherwise would send the client to a URL that
// 404s from S3 instead.
export class GetDocumentArtifactUrl {
  constructor(
    private readonly files: FileStorage,
    private readonly settings: DownloadSettings,
  ) {}

  async execute(detail: DocumentDetail, kind: ArtifactKind): Promise<Download> {
    const { document } = detail;
    if (document.steps.preview !== 'DONE') {
      throw new NotFoundError('NOT_FOUND', 'This document has no preview');
    }
    return {
      kind: 'redirect',
      url: await this.files.getSignedUrl(
        kind === 'preview'
          ? artifactKeys.preview(document.id)
          : artifactKeys.thumbnail(document.id),
        this.settings.signedUrlTtlSec,
      ),
    };
  }
}

// GET /api/documents/:id/markdown (docs/07 §7.3): the extracted text, or null when there is none.
export class GetDocumentMarkdown {
  execute(detail: DocumentDetail): { markdown: string | null } {
    return { markdown: detail.document.markdown };
  }
}
