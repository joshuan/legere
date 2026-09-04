import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOCUMENT_ID,
  documentFixture,
  FakeAnalyst,
  FakeCallContext,
  FakeDocumentEventRepository,
  FakeDocumentParser,
  FakeEmbeddingProvider,
  FakeImageTool,
  FakePdfToolbox,
  FakeTranscriber,
  ImmediateUnitOfWork,
  InMemoryCategoryRepository,
  InMemoryDocumentChunkRepository,
  InMemoryDocumentRepository,
  InMemoryFileRefRepository,
  InMemoryFileRepository,
  InMemoryLibraryRepository,
  InMemoryPersonRepository,
  InMemorySettingsRepository,
  InMemorySubjectKindRepository,
  InMemorySubjectRepository,
  libraryFixture,
  queueSettingsFixture,
  StubLibraryReader,
} from '../../../../test/helpers/processing-fakes';
import { FixedClock } from '../../../../test/helpers/fakes';
import type { Document, DocumentSteps } from '../../domain/entities/document';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { BuildCanonical } from '../documents/build-canonical';
import { AnalysisSettings } from '../settings/analysis-settings';
import type { ProcessingSettings } from './processing-settings';
import { HandleDocumentProcess } from './handle-document-process';

// A document whose first three steps have already run, so a `steps: ['analysis']` job goes straight
// to step 4 — the only step this suite is about.
const EXTRACTED_STEPS: DocumentSteps = {
  canonical: 'DONE',
  preview: 'DONE',
  markdown: 'DONE',
  analysis: 'PENDING',
  fields: 'PENDING',
  vectorization: 'PENDING',
};

// 🔒 SEC-11: the analyst can recognise a living row, but it cannot create an instance-wide one.
// Novel names survive as proposals in `autoValues` for the explicit viewer Edit → Add → Save flow.
describe('HandleDocumentProcess catalogue proposals', () => {
  let documents: InMemoryDocumentRepository;
  let analyst: FakeAnalyst;
  let people: InMemoryPersonRepository;
  let subjectKinds: InMemorySubjectKindRepository;
  let subjects: InMemorySubjectRepository;
  let handler: HandleDocumentProcess;

  beforeEach(() => {
    documents = new InMemoryDocumentRepository();
    analyst = new FakeAnalyst();
    people = new InMemoryPersonRepository();
    subjectKinds = new InMemorySubjectKindRepository();
    subjects = new InMemorySubjectRepository(subjectKinds);

    const fileRepo = new InMemoryFileRepository();
    const fileRefs = new InMemoryFileRefRepository();
    const libraries = new InMemoryLibraryRepository();
    libraries.add(libraryFixture());
    const storage = new InMemoryFileStorage();
    const pdfs = new FakePdfToolbox();
    const images = new FakeImageTool();
    const settings: ProcessingSettings = {
      previewMaxDim: 1600,
      thumbMaxDim: 400,
      ocrLanguages: ['rus', 'eng'],
      pdfTextMinCharsPerPage: 32,
      correctImagePages: true,
      chunkTargetChars: 200,
      chunkOverlapChars: 40,
      analystExcerptChars: 0,
      // No page images: what the analyst is shown has its own suite, and rendering is noise here.
      analystMaxPageImages: 0,
      analystPageImageMaxDim: 1200,
      analystAutoMaxPages: 0,
      transcriberMaxPages: 0,
      transcriberPageImageMaxDim: 1600,
    };

    handler = new HandleDocumentProcess(
      documents,
      new FakeDocumentEventRepository(),
      new BuildCanonical(
        fileRepo,
        fileRefs,
        libraries,
        new StubLibraryReader(),
        storage,
        images,
        pdfs,
        queueSettingsFixture(),
        settings,
      ),
      storage,
      pdfs,
      new FakeDocumentParser(),
      images,
      new InMemoryCategoryRepository(),
      analyst,
      new FakeTranscriber(),
      people,
      subjects,
      subjectKinds,
      new InMemoryDocumentChunkRepository(),
      new FakeEmbeddingProvider(),
      new ImmediateUnitOfWork(),
      new FakeCallContext(),
      new AnalysisSettings(new InMemorySettingsRepository()),
      queueSettingsFixture(),
      settings,
      new FixedClock(),
    );
  });

  function givenExtractedDocument(): Document {
    return documents.add(
      documentFixture({
        steps: EXTRACTED_STEPS,
        pageCount: 1,
        markdown: 'Lease for the flat at Njegoševa 5, between two parties.',
      }),
    );
  }

  async function analyse(): Promise<Document> {
    await handler.handle({ documentId: DOCUMENT_ID, steps: ['analysis'] });
    const document = documents.documents.get(DOCUMENT_ID);
    if (document === undefined) throw new Error('The document under test disappeared');
    return document;
  }

  it('links a living person, keeps a novel name as a proposal, and creates no row', async () => {
    const known = await people.create({ name: 'Person 1' });
    analyst.answer = { ...analyst.answer, people: ['Person 1', 'Somebody Never Seen'] };
    givenExtractedDocument();

    const document = await analyse();

    expect(document.processingError).toBeNull();
    expect(document.steps.analysis).toBe('DONE');
    expect(people.links.get(DOCUMENT_ID)).toEqual([known.id]);
    expect(await people.countActive()).toBe(1);
    expect(document.auto.people).toEqual(['Person 1', 'Somebody Never Seen']);
  });

  it('links a living subject and keeps novel subjects and kinds only as proposals', async () => {
    const car = await subjectKinds.create({ name: 'kind 1' });
    const known = await subjects.create({ kindId: car.id, name: 'Lacetti' });
    analyst.answer = {
      ...analyst.answer,
      subjects: [
        { kind: 'kind 1', name: 'Lacetti' },
        { kind: 'kind 1', name: 'A Thing Never Seen' },
        { kind: 'a kind never seen', name: 'Montenegro' },
      ],
    };
    givenExtractedDocument();

    const document = await analyse();

    expect(document.steps.analysis).toBe('DONE');
    const filed = await subjects.listForDocument(DOCUMENT_ID);
    expect(filed.map((subject) => subject.id)).toEqual([known.id]);
    expect(await subjects.countActive()).toBe(1);
    expect(await subjectKinds.countActive()).toBe(1);
    expect(document.auto.subjects).toEqual([
      { kind: 'kind 1', name: 'Lacetti' },
      { kind: 'kind 1', name: 'A Thing Never Seen' },
      { kind: 'a kind never seen', name: 'Montenegro' },
    ]);
  });

  it('does not write an empty link set when every answer is novel', async () => {
    analyst.answer = { ...analyst.answer, people: ['Novel Person'] };
    givenExtractedDocument();

    const document = await analyse();

    expect(document.steps.analysis).toBe('DONE');
    expect(people.links.has(DOCUMENT_ID)).toBe(false);
    expect(await people.countActive()).toBe(0);
    expect(document.auto.people).toEqual(['Novel Person']);
  });
});
