import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeImageTool,
  FakePdfToolbox,
  InMemoryFileRefRepository,
  InMemoryFileRepository,
  InMemoryLibraryRepository,
  InMemorySettingsRepository,
  StubLibraryReader,
  documentFixture,
} from '../../../../test/helpers/processing-fakes';
import type { Crop } from '../../../shared/contracts/documents';
import type { ProcessingSettings } from '../jobs/processing-settings';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { withFileCrop } from '../../domain/entities/document-page';
import { QueueSettings, ungatedServices } from '../queue/queue-settings';
import { BuildCanonical } from './build-canonical';

// An image is corrected on its way into the canonical — the lighting levelled, the skew taken out —
// and it is the corrected page the canonical carries, so what a reader downloads is the improved one
// and not a second copy kept somewhere (docs/05 §5.5 step 1). What the correction *does* is
// sharp-image-tool.test.ts; this is about when it runs, what it runs on, and what happens when it
// cannot.

const SETTINGS: ProcessingSettings = {
  previewMaxDim: 1600,
  thumbMaxDim: 400,
  ocrLanguages: ['rus', 'eng'],
  // Every document here is judged to be a scan, which is the branch a photograph takes.
  pdfTextMinCharsPerPage: 10_000,
  correctImagePages: true,
  chunkTargetChars: 200,
  chunkOverlapChars: 40,
  analystExcerptChars: 0,
  analystMaxPageImages: 20,
  analystPageImageMaxDim: 1200,
  analystAutoMaxPages: 0,
  transcriberMaxPages: 0,
  transcriberPageImageMaxDim: 1600,
};

const CROP: Crop = {
  points: [
    [0.1, 0.1],
    [0.9, 0.1],
    [0.9, 0.9],
    [0.1, 0.9],
  ],
};

describe('BuildCanonical: correcting a page before it is one', () => {
  let files: InMemoryFileRepository;
  let pdfs: FakePdfToolbox;
  let images: FakeImageTool;
  let storage: InMemoryFileStorage;

  beforeEach(() => {
    files = new InMemoryFileRepository();
    pdfs = new FakePdfToolbox();
    images = new FakeImageTool();
    storage = new InMemoryFileStorage();
  });

  const buildWith = (settings: ProcessingSettings = SETTINGS): BuildCanonical =>
    new BuildCanonical(
      files,
      new InMemoryFileRefRepository(),
      new InMemoryLibraryRepository(),
      new StubLibraryReader(),
      storage,
      images,
      pdfs,
      new QueueSettings(new InMemorySettingsRepository(), {
        concurrency: {
          'library-scan': 1,
          'file-ingest': 1,
          'document-process': 1,
          maintenance: 1,
        },
        unitConcurrency: 1,
        services: ungatedServices(),
      }),
      settings,
    );

  const givenPhotograph = async (
    documentId: string,
    options: { crop?: Crop; ext?: string } = {},
  ): Promise<void> => {
    const ext = options.ext ?? 'jpg';
    const { file } = await files.findOrCreateByContentHash({
      contentHash: `hash-${documentId}`,
      origin: 'MANAGED',
      storageKey: `documents/${documentId}/source.${ext}`,
      mimeType: ext === 'png' ? 'image/png' : 'image/jpeg',
      ext,
      sizeBytes: 1n,
      name: `page.${ext}`,
    });
    await files.attach(documentId, file.id);
    // A crop belongs to the page the file is read as here (docs/03 §3.3.17), so it is said by
    // rewriting the list exactly as a composition edit does.
    const crop = options.crop;
    if (crop !== undefined) {
      const held = await files.listPagesForDocument(documentId);
      await files.replacePages(documentId, withFileCrop(held, file.id, crop, 'MANUAL'));
    }
    await storage.put(
      `documents/${documentId}/source.${ext}`,
      Buffer.from('photograph'),
      'image/jpeg',
    );
  };

  // What the converter was handed as the page.
  const pageSentToPdf = (): string => {
    const call = pdfs.calls.find((entry) => entry.method === 'imagesToPdf');
    if (call === undefined) throw new Error('no page was converted');
    return call.fileName ?? '';
  };

  it('gives the canonical the corrected page rather than the one the camera took', async () => {
    images.correction = 'applied';
    const document = documentFixture();
    await givenPhotograph(document.id);

    const built = await buildWith().execute(document);

    expect(built.kind).toBe('built');
    expect(images.corrections).toEqual(['photograph']);
    // The bytes that became page one are the corrected ones: the canonical is the artifact every
    // later step reads and the one a reader downloads, so a correction kept anywhere else would be
    // a correction nobody sees.
    expect(pdfs.calls).toContainEqual({
      method: 'imagesToPdf',
      fileName: 'page-0000.jpg',
    });
    const merged = pdfs.markdownReads.at(0) ?? '';
    expect(merged).toContain('corrected(photograph)');
  });

  // 🔒 The order the whole thing depends on. A photograph carries the desk it was lying on, and
  // lighting levelled over the desk levels the desk; the crop is what says which of those pixels are
  // the page (docs/05 §5.6).
  it('corrects what the crop left, not what the camera saw', async () => {
    images.correction = 'applied';
    const document = documentFixture();
    await givenPhotograph(document.id, { crop: CROP });

    await buildWith().execute(document);

    expect(images.crops.map((call) => call.input)).toEqual(['photograph']);
    expect(images.corrections).toEqual(['cropped(0.1,0.1):photograph']);
  });

  it('keeps the page a scanner already got right', async () => {
    // `none` is the flat, evenly lit, straight page: the port answers that it needs nothing, and the
    // file's own bytes — and its own format — go on to the converter untouched.
    images.correction = 'none';
    const document = documentFixture();
    await givenPhotograph(document.id, { ext: 'png' });

    await buildWith().execute(document);

    expect(images.corrections).toEqual(['photograph']);
    expect(pageSentToPdf()).toBe('page-0000.png');
    expect(pdfs.markdownReads.at(0) ?? '').toContain('image-pdf(photograph)');
  });

  it('still makes a page out of an image the correction could not handle', async () => {
    images.correction = 'failing';
    const document = documentFixture();
    await givenPhotograph(document.id);

    const built = await buildWith().execute(document);

    // Best-effort by contract: losing a document over a failed filter would be a poor trade
    // (docs/05 §5.5 step 1). The page is the picture as it arrived.
    expect(built.kind).toBe('built');
    expect(pageSentToPdf()).toBe('page-0000.jpg');
    expect(pdfs.markdownReads.at(0) ?? '').toContain('image-pdf(photograph)');
  });

  it('does not touch a page at all when the instance turned the correction off', async () => {
    images.correction = 'applied';
    const document = documentFixture();
    await givenPhotograph(document.id);

    const built = await buildWith({ ...SETTINGS, correctImagePages: false }).execute(document);

    expect(built.kind).toBe('built');
    expect(images.corrections).toEqual([]);
    expect(pdfs.markdownReads.at(0) ?? '').toContain('image-pdf(photograph)');
  });
});
