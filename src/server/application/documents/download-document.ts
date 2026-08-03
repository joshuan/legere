import type { Readable } from 'node:stream';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentDetail } from '../../domain/repositories/document.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import { RelativePath } from '../../domain/value-objects/relative-path';
import type { Clock } from '../ports/clock';
import type { FileStorage } from '../ports/file-storage';
import type { LibraryReader } from '../ports/library-reader';
import { artifactKeys } from '../storage/artifact-keys';

// Bytes reach a client one of two ways (docs/09 §9.1–9.2): a library file is streamed through the
// app, and anything Legere derived is handed over as a short-lived signed URL. There are no direct
// links to either.
export type Download =
  | {
      kind: 'stream';
      body: Readable;
      contentType: string;
      contentLength: bigint;
      fileName: string;
    }
  | { kind: 'redirect'; url: string };

export type DownloadSettings = {
  signedUrlTtlSec: number;
};

// Which derived artifact a route is after (docs/09 §9.2).
export type ArtifactKind = 'preview' | 'thumb' | 'canonical';

export class DownloadDocumentSource {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly reader: LibraryReader,
    private readonly files: FileStorage,
    private readonly clock: Clock,
    private readonly settings: DownloadSettings,
  ) {}

  async execute(detail: DocumentDetail): Promise<Download> {
    const { document } = detail;

    if (document.source !== 'LIBRARY') {
      // The bytes are ours: a merged scan set, or a file somebody uploaded (docs/09 §9.2).
      return {
        kind: 'redirect',
        url: await this.files.getSignedUrl(
          artifactKeys.source(document.id, document.ext),
          this.settings.signedUrlTtlSec,
        ),
      };
    }

    // The first live file, among the ones this caller may see — the detail's refs are already
    // filtered to visible libraries (docs/09 §9.1).
    const ref = detail.fileRefs.find((candidate) => candidate.status === 'HASHED');
    if (ref === undefined) {
      throw new ConflictError('DOCUMENT_UNAVAILABLE', 'No file of this document is available');
    }

    const library = await this.libraries.findById(ref.libraryId);
    if (library === null || library.deletedAt !== null) {
      throw new ConflictError('DOCUMENT_UNAVAILABLE', 'No file of this document is available');
    }

    const path = RelativePath.tryParse(ref.path);
    if (path === null) {
      throw new ConflictError('DOCUMENT_UNAVAILABLE', 'No file of this document is available');
    }

    const body = await this.reader
      .openStream({ rootPath: library.rootPath, excludeGlobs: library.excludeGlobs }, path)
      .catch(async (error: unknown) => {
        // The file went away between the scan and this request. Recording it keeps the next listing
        // honest instead of offering a download that fails again (docs/09 §9.1).
        await this.markMissing(ref.libraryId, ref.path);
        throw new ConflictError(
          'DOCUMENT_UNAVAILABLE',
          `The file is no longer on the volume: ${error instanceof Error ? error.message : ''}`,
        );
      });

    return {
      kind: 'stream',
      body,
      contentType: document.mimeType,
      // One content, one size (ADR-009): every ref of a document holds the same bytes, and this is
      // the size the scan recorded for them.
      contentLength: document.sizeBytes,
      fileName: `${document.title}.${document.ext === '' ? 'bin' : document.ext}`,
    };
  }

  private async markMissing(libraryId: string, path: string): Promise<void> {
    const parsed = RelativePath.tryParse(path);
    if (parsed === null) return;
    const ref = await this.fileRefs.findByPath(libraryId, parsed);
    if (ref === null) return;
    await this.fileRefs.markMissing([ref.id], this.clock.now());
  }
}

// preview.jpg / thumb.jpg / canonical.pdf as a signed URL (docs/09 §9.2). A step that never
// produced its artifact is a 404: there is nothing to hand out, and pretending otherwise would send
// the client to a URL that 404s from S3 instead.
export class GetDocumentArtifactUrl {
  constructor(
    private readonly files: FileStorage,
    private readonly source: DownloadDocumentSource,
    private readonly settings: DownloadSettings,
  ) {}

  async execute(detail: DocumentDetail, kind: ArtifactKind): Promise<Download> {
    const { document } = detail;

    if (kind === 'canonical') {
      // A PDF has no canonical copy — it already is one, so /canonical is /source (docs/07 §7.3).
      if (document.steps.canonical !== 'DONE') {
        if (document.mimeType === 'application/pdf') return this.source.execute(detail);
        throw new NotFoundError('NOT_FOUND', 'This document has no canonical PDF');
      }
      return this.signed(artifactKeys.canonicalPdf(document.id));
    }

    if (document.steps.preview !== 'DONE') {
      throw new NotFoundError('NOT_FOUND', 'This document has no preview');
    }
    return this.signed(
      kind === 'preview' ? artifactKeys.preview(document.id) : artifactKeys.thumbnail(document.id),
    );
  }

  private async signed(key: string): Promise<Download> {
    return {
      kind: 'redirect',
      url: await this.files.getSignedUrl(key, this.settings.signedUrlTtlSec),
    };
  }
}

// GET /api/documents/:id/markdown (docs/07 §7.3): the extracted text, or null when there is none.
export class GetDocumentMarkdown {
  execute(detail: DocumentDetail): { markdown: string | null } {
    return { markdown: detail.document.markdown };
  }
}
