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
import { MAX_LIVING_PEOPLE } from '../../domain/entities/person';
import { MAX_LIVING_SUBJECTS } from '../../domain/entities/subject';
import { MAX_LIVING_SUBJECT_KINDS } from '../../domain/entities/subject-kind';
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

// 🔒 The instance ceilings of docs/08 §8.4 as the pipeline honours them (docs/05 §5.5 step 4,
// SEC-51, SEC-56): a full catalogue is never a reason a document fails. The analysis links every
// name that matches a living row, quietly stops creating new ones, and completes — the skipped
// readings stay recorded in `autoValues`, where the whole answer is written either way. Kept apart
// from the main HandleDocumentProcess suite on purpose: these tests seed catalogues to their
// ceilings, and the harness they need is the analysis step alone.
describe('HandleDocumentProcess at the catalogue ceilings', () => {
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

  it('links the living person and skips the new one when the people catalogue is full, and the document completes', async () => {
    const known = await people.create({ name: 'Person 1' });
    for (let index = 2; index <= MAX_LIVING_PEOPLE; index += 1) {
      await people.create({ name: `Person ${index}` });
    }
    analyst.answer = { ...analyst.answer, people: ['Person 1', 'Somebody Never Seen'] };
    givenExtractedDocument();

    const document = await analyse();

    // The step settled rather than failed: a ceiling only a flood reaches must not decide the fate
    // of an honest scan that arrives during one (docs/05 §5.5 step 4).
    expect(document.processingError).toBeNull();
    expect(document.steps.analysis).toBe('DONE');
    // What lives is linked; what would need a new row is not created.
    expect(people.links.get(DOCUMENT_ID)).toEqual([known.id]);
    expect(await people.countActive()).toBe(MAX_LIVING_PEOPLE);
    // And nothing is lost: the whole reading is recorded, skipped names included.
    expect(document.auto.people).toEqual(['Person 1', 'Somebody Never Seen']);
  });

  it('creates no kind past the kinds ceiling but still files a thing under a kind that lives', async () => {
    const car = await subjectKinds.create({ name: 'kind 1' });
    for (let index = 2; index <= MAX_LIVING_SUBJECT_KINDS; index += 1) {
      await subjectKinds.create({ name: `kind ${index}` });
    }
    analyst.answer = {
      ...analyst.answer,
      subjects: [
        { kind: 'kind 1', name: 'Lacetti' },
        { kind: 'a kind never seen', name: 'Montenegro' },
      ],
    };
    givenExtractedDocument();

    const document = await analyse();

    expect(document.steps.analysis).toBe('DONE');
    // The living kind still takes its new thing — the subjects catalogue has room.
    const filed = await subjects.listForDocument(DOCUMENT_ID);
    expect(filed.map((subject) => ({ kindId: subject.kindId, name: subject.name }))).toEqual([
      { kindId: car.id, name: 'Lacetti' },
    ]);
    // The unknown kind was not created: no row, and no empty shelf either.
    expect(await subjectKinds.countActive()).toBe(MAX_LIVING_SUBJECT_KINDS);
    expect(document.auto.subjects).toEqual([
      { kind: 'kind 1', name: 'Lacetti' },
      { kind: 'a kind never seen', name: 'Montenegro' },
    ]);
  });

  it('links the existing thing and creates neither subject nor kind when the subjects catalogue is full', async () => {
    const car = await subjectKinds.create({ name: 'car' });
    await subjects.create({ kindId: car.id, name: 'Lacetti' });
    for (let index = 2; index <= MAX_LIVING_SUBJECTS; index += 1) {
      await subjects.create({ kindId: car.id, name: `Thing ${index}` });
    }
    analyst.answer = {
      ...analyst.answer,
      subjects: [
        { kind: 'car', name: 'Lacetti' },
        { kind: 'car', name: 'A Thing Never Seen' },
        // A new kind whose only thing may not be filed: the kind is not created for it.
        { kind: 'plane', name: 'Cessna' },
      ],
    };
    givenExtractedDocument();

    const document = await analyse();

    expect(document.processingError).toBeNull();
    expect(document.steps.analysis).toBe('DONE');
    const filed = await subjects.listForDocument(DOCUMENT_ID);
    expect(filed.map((subject) => subject.name)).toEqual(['Lacetti']);
    expect(await subjects.countActive()).toBe(MAX_LIVING_SUBJECTS);
    expect(await subjectKinds.countActive()).toBe(1);
  });
});
