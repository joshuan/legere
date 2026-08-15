import type { Readable } from 'node:stream';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentDetail } from '../../domain/repositories/document.repository';
import { toBuffer } from '../ports/binary-source';
import type { Delivery, FileStorage } from '../ports/file-storage';
import type { ImageTool } from '../ports/image-tool';
import type { PdfToolbox } from '../ports/pdf-toolbox';
import { artifactKeys, originalDelivery, originalKeyOf } from '../storage/artifact-keys';
import { assertPdf, fileOf } from './compose-document';
import type { DocumentFileBytes } from './document-file-bytes';

// Bytes reach a client one of two ways (docs/09 §9.1–9.2): what sits on the read-only volume is
// streamed through the app, and anything Legere keeps in its own bucket is handed over as a
// short-lived signed URL. There are no direct links to either.
//
// Both carry the same `delivery`: how the bytes are to be treated is decided here, once, rather than
// by whichever route happens to write the headers — a redirect that forgot to say it is the hole
// SEC-03 was.
export type Download =
  | {
      kind: 'stream';
      body: Readable;
      delivery: Delivery;
      // Absent when nothing knows it without asking the bucket; the client then reads to the end.
      contentLength?: bigint;
    }
  | { kind: 'redirect'; url: string; delivery: Delivery };

export type DownloadSettings = {
  signedUrlTtlSec: number;
};

// What a page thumbnail costs to make: the resolution it is rendered at, and the size it is kept at
// (docs/09 §9.2). The same two numbers the document's own thumbnail uses, for the same reason —
// these are pictures of pages, shown a strip at a time.
export type PageThumbSettings = DownloadSettings & {
  thumbMaxDim: number;
};

// All a page render needs of the bytes port: one file, opened (docs/09 §9.1–9.2). Named so the
// dependency is the method rather than the class — the real `DocumentFileBytes` satisfies it, and a
// test needs no stand-in for the rest of it.
export type FileBytesReader = Pick<DocumentFileBytes, 'open'>;

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
      // Viewed rather than saved: this is what the `<object>` on the page points at, and a signed URL
      // serves the range requests a PDF viewer makes without going through us (docs/09 §9.2). The one
      // thing Legere builds itself out of everything it was given, so it is also the one original
      // that may render — in the storage origin, where no session cookie of ours exists (SEC-39).
      const delivery: Delivery = { disposition: 'inline', contentType: 'application/pdf' };
      return {
        kind: 'redirect',
        delivery,
        url: await this.files.getSignedUrl(key, this.settings.signedUrlTtlSec, delivery),
      };
    }

    // Saved rather than viewed: streamed through the app, because the name the person ends up with
    // is the title of the document and only this response can say so (docs/11 §11.5b).
    return {
      kind: 'stream',
      body: await this.files.getStream(key),
      delivery: {
        disposition: 'attachment',
        contentType: 'application/pdf',
        fileName: `${document.title}.pdf`,
      },
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
    // 🔒 The same terms whichever storage holds it: something to save, named as it arrived
    // (docs/11 §11.5b) — not after the document, which may be made of forty of these — and claiming
    // to be its own type only when that is a type a browser may safely render (docs/09 §9.2).
    const file = fileOf(detail, fileId);
    const delivery = originalDelivery(file);

    if (file.origin === 'MANAGED') {
      return {
        kind: 'redirect',
        delivery,
        url: await this.files.getSignedUrl(
          originalKeyOf(file),
          this.settings.signedUrlTtlSec,
          delivery,
        ),
      };
    }

    return {
      kind: 'stream',
      body: await this.bytes.open(file),
      delivery,
      contentLength: file.sizeBytes,
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
    // What an <img> on the page points at: rendered where it stands, and a picture Legere rendered
    // itself rather than anything a person uploaded (docs/05 §5.5 step 2).
    const delivery: Delivery = { disposition: 'inline', contentType: 'image/jpeg' };
    return {
      kind: 'redirect',
      delivery,
      url: await this.files.getSignedUrl(
        kind === 'preview'
          ? artifactKeys.preview(document.id)
          : artifactKeys.thumbnail(document.id),
        this.settings.signedUrlTtlSec,
        delivery,
      ),
    };
  }
}

// GET /api/documents/:id/files/:fileId/pages/:page/thumb (docs/07 §7.3): one page of one **original**
// file, small. Not a page of the canonical — the canonical's pages are already the answer, and what
// somebody putting a shuffled scan in order needs to look at is the pages as they arrived
// (docs/11 §11.5a).
//
// Rendered on the first request and kept in the bucket (docs/09 §9.2); every request after that is a
// redirect to the object. 🔒 That cache never goes stale, and the reason is a rule rather than a
// guess: file bytes are never rewritten (docs/03 §3.3.16) and a page order is written beside the
// file, so page 3 of a file is the same picture for ever.
//
// 🔒 The access check is the guard on the route, exactly as for the file's own content: these are
// the same bytes, one page at a time, and the object behind them is only reachable through a signed
// URL this endpoint issues after that guard has passed.
export class GetDocumentFilePageThumb {
  constructor(
    private readonly bytes: FileBytesReader,
    private readonly storage: FileStorage,
    private readonly pdfs: PdfToolbox,
    private readonly images: ImageTool,
    private readonly settings: PageThumbSettings,
  ) {}

  async execute(detail: DocumentDetail, fileId: string, page: number): Promise<Download> {
    const file = fileOf(detail, fileId);
    assertPdf(file);

    // Bounded by what the last build counted, and a file no build has opened has no pages to ask
    // for: an unbounded page number is a render and an object per request, which is a bill anybody
    // with a session could run up (docs/07 §7.3).
    if (file.pageCount === null || page >= file.pageCount) {
      throw new NotFoundError('NOT_FOUND', 'This file has no such page');
    }

    const key = artifactKeys.filePageThumb(file.id, page);
    if (!(await this.storage.exists(key))) {
      const rendered = await this.pdfs.pdfPageJpg(await toBuffer(await this.bytes.open(file)), {
        // Stirling counts pages from one; this route counts from zero, the way a page order does.
        page: page + 1,
      });
      const thumb = await this.images.toJpegPreview(rendered, {
        maxDim: this.settings.thumbMaxDim,
      });
      await this.storage.put(key, thumb, 'image/jpeg');
    }

    // A picture Legere rendered itself, shown where it stands — the terms the document's own preview
    // is served on (docs/09 §9.2).
    const delivery: Delivery = { disposition: 'inline', contentType: 'image/jpeg' };
    return {
      kind: 'redirect',
      delivery,
      url: await this.storage.getSignedUrl(key, this.settings.signedUrlTtlSec, delivery),
    };
  }
}

// GET /api/documents/:id/markdown (docs/07 §7.3): the extracted text, or null when there is none.
export class GetDocumentMarkdown {
  execute(detail: DocumentDetail): { markdown: string | null } {
    return { markdown: detail.document.markdown };
  }
}
