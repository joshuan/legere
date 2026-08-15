import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeImageTool,
  FakePdfToolbox,
  documentFixture,
  fileFixture,
} from '../../../../test/helpers/processing-fakes';
import type { File } from '../../domain/entities/file';
import { NotFoundError, UnprocessableError } from '../../domain/errors/domain-error';
import type { DocumentDetail } from '../../domain/repositories/document.repository';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { artifactKeys } from '../storage/artifact-keys';
import { GetDocumentFilePageThumb, type FileBytesReader } from './download-document';

// GET /api/documents/:id/files/:fileId/pages/:page/thumb (docs/07 §7.3, docs/09 §9.2): one page of
// one original, rendered on the first request and then simply there. The access check is the guard
// on the route and is proven in the e2e suite; what is decided here is that the render happens once.

const FILE_ID = 'ffffffff-1111-4111-8111-111111111111';
const THUMB_MAX_DIM = 400;

// The one method the thumb needs of the bytes port: a file, opened (docs/09 §9.1–9.2).
class StubFileBytes implements FileBytesReader {
  reads = 0;

  open(): Promise<Readable> {
    this.reads += 1;
    return Promise.resolve(Readable.from(Buffer.from('the original pdf')));
  }
}

describe('GetDocumentFilePageThumb', () => {
  let bytes: StubFileBytes;
  let storage: InMemoryFileStorage;
  let pdfs: FakePdfToolbox;
  let images: FakeImageTool;
  let thumb: GetDocumentFilePageThumb;

  beforeEach(() => {
    bytes = new StubFileBytes();
    storage = new InMemoryFileStorage();
    pdfs = new FakePdfToolbox();
    images = new FakeImageTool();
    thumb = new GetDocumentFilePageThumb(bytes, storage, pdfs, images, {
      signedUrlTtlSec: 300,
      thumbMaxDim: THUMB_MAX_DIM,
    });
  });

  function given(overrides: Partial<File> = {}): DocumentDetail {
    const file = fileFixture({
      id: FILE_ID,
      mimeType: 'application/pdf',
      ext: 'pdf',
      name: 'scan.pdf',
      pageCount: 3,
      ...overrides,
    });
    return {
      document: documentFixture(),
      documentType: null,
      people: [],
      subjects: [],
      files: [{ ...file, position: 0, available: true, refs: [], earlierVersions: [] }],
      createdBy: null,
    };
  }

  it('renders the page once and serves the object ever after', async () => {
    const detail = given();

    const first = await thumb.execute(detail, FILE_ID, 1);

    // Rendered from the original, at the page number Stirling counts from one.
    expect(pdfs.calls.map((call) => call.method)).toEqual(['pdfPageJpg']);
    expect(images.resizes).toEqual([
      { maxDim: THUMB_MAX_DIM, quality: undefined, input: 'rendered-page' },
    ]);
    const key = artifactKeys.filePageThumb(FILE_ID, 1);
    expect(storage.keys()).toEqual([key]);
    expect(first.kind).toBe('redirect');
    // Shown where it stands: a picture Legere rendered itself (docs/09 §9.2).
    expect(first.delivery).toEqual({ disposition: 'inline', contentType: 'image/jpeg' });

    const second = await thumb.execute(detail, FILE_ID, 1);

    // 🔒 The bytes it was drawn from are immutable, so the cached picture can never be stale — and
    // nothing is asked of Stirling, of the volume, or of sharp a second time (docs/09 §9.2).
    expect(pdfs.calls).toHaveLength(1);
    expect(bytes.reads).toBe(1);
    expect(images.resizes).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('renders each page separately, under a key of its own', async () => {
    const detail = given();

    await thumb.execute(detail, FILE_ID, 0);
    await thumb.execute(detail, FILE_ID, 2);

    expect(storage.keys()).toEqual([
      artifactKeys.filePageThumb(FILE_ID, 0),
      artifactKeys.filePageThumb(FILE_ID, 2),
    ]);
  });

  it('has no page to answer past the count the last build recorded', async () => {
    const detail = given();

    await expect(thumb.execute(detail, FILE_ID, 3)).rejects.toBeInstanceOf(NotFoundError);
    // 🔒 Nothing rendered, nothing stored: an unbounded page number would be a render and an object
    // per request (docs/07 §7.3).
    expect(storage.keys()).toEqual([]);
  });

  it('has no page to answer for a file no build has opened', async () => {
    const detail = given({ pageCount: null });

    await expect(thumb.execute(detail, FILE_ID, 0)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a file that has no pages at all', async () => {
    const detail = given({
      mimeType: 'image/jpeg',
      ext: 'jpg',
      name: 'photo.jpg',
      pageCount: null,
    });

    await expect(thumb.execute(detail, FILE_ID, 0)).rejects.toBeInstanceOf(UnprocessableError);
  });
});
