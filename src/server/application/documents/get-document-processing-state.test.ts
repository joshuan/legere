import { beforeEach, describe, expect, it } from 'vitest';
import {
  documentFixture,
  InMemorySettingsRepository,
  queueSettingsFixture,
} from '../../../../test/helpers/processing-fakes';
import { documentProcessingStateSchema } from '../../../shared/contracts/processing';
import type { DocumentStep } from '../../../shared/contracts/documents';
import type { DocumentDetail } from '../../domain/repositories/document.repository';
import type { QueueSettings } from '../queue/queue-settings';
import { GetDocumentProcessingState } from './get-document-processing-state';

describe('GetDocumentProcessingState', () => {
  let settings: QueueSettings;
  let getState: GetDocumentProcessingState;

  beforeEach(() => {
    settings = queueSettingsFixture(4, new InMemorySettingsRepository());
    getState = new GetDocumentProcessingState(settings);
  });

  it('returns every step in topology order and no operational settings when nothing is paused', async () => {
    const result = await getState.execute(detail());

    expect(documentProcessingStateSchema.parse(result)).toEqual(result);
    expect(result).toEqual({
      pausedSteps: [],
      steps: [
        { step: 'canonical', blockers: [] },
        { step: 'preview', blockers: [] },
        { step: 'markdown', blockers: [] },
        { step: 'analysis', blockers: [] },
        { step: 'fields', blockers: [] },
        { step: 'vectorization', blockers: [] },
      ],
    });
  });

  it('cascades an unsettled canonical pause through its actual dependency paths', async () => {
    await pause(['canonical']);

    const result = await getState.execute(detail());

    expect(blockers(result, 'canonical')).toEqual([{ kind: 'STEP_PAUSED', step: 'canonical' }]);
    expect(blockers(result, 'preview')).toEqual([
      {
        kind: 'DEPENDENCY_PAUSED',
        step: 'canonical',
        path: ['canonical', 'preview'],
        condition: 'UPSTREAM_UNSETTLED',
      },
    ]);
    expect(blockers(result, 'markdown')).toEqual([
      {
        kind: 'DEPENDENCY_PAUSED',
        step: 'canonical',
        path: ['canonical', 'markdown'],
        condition: 'UPSTREAM_UNSETTLED',
      },
    ]);
    expect(blockers(result, 'fields')).toEqual([
      {
        kind: 'DEPENDENCY_PAUSED',
        step: 'canonical',
        path: ['canonical', 'markdown', 'fields'],
        condition: 'UPSTREAM_UNSETTLED',
      },
    ]);
  });

  it('cascades Markdown to analysis, fields and vectorization by the shortest direct paths', async () => {
    await pause(['markdown']);

    const result = await getState.execute(detail());

    expect(blockers(result, 'markdown')).toEqual([{ kind: 'STEP_PAUSED', step: 'markdown' }]);
    for (const step of ['analysis', 'fields', 'vectorization'] as const) {
      expect(blockers(result, step)).toEqual([
        {
          kind: 'DEPENDENCY_PAUSED',
          step: 'markdown',
          path: ['markdown', step],
          condition: 'UPSTREAM_UNSETTLED',
        },
      ]);
    }
  });

  it('holds untyped fields behind analysis but lets a document with an existing type proceed', async () => {
    await pause(['analysis']);

    const untyped = await getState.execute(detail());
    const typed = await getState.execute(detail({ typeId: 'known-type' }));

    expect(blockers(untyped, 'fields')).toEqual([
      {
        kind: 'DEPENDENCY_PAUSED',
        step: 'analysis',
        path: ['analysis', 'fields'],
        condition: 'UPSTREAM_UNSETTLED_AND_TYPE_MISSING',
      },
    ]);
    expect(blockers(typed, 'analysis')).toEqual([{ kind: 'STEP_PAUSED', step: 'analysis' }]);
    expect(blockers(typed, 'fields')).toEqual([]);
  });

  it('does not inherit a pause through settled upstream input already held by the document', async () => {
    await pause(['canonical']);
    const result = await getState.execute(
      detail({
        steps: {
          canonical: 'PENDING',
          preview: 'PENDING',
          markdown: 'DONE',
          analysis: 'PENDING',
          fields: 'PENDING',
          vectorization: 'PENDING',
        },
      }),
    );

    expect(blockers(result, 'preview')).toHaveLength(1);
    expect(blockers(result, 'markdown')).toEqual([]);
    expect(blockers(result, 'analysis')).toEqual([]);
    expect(blockers(result, 'fields')).toEqual([]);
    expect(blockers(result, 'vectorization')).toEqual([]);
  });

  it('does not call a settled directly paused step blocked', async () => {
    await pause(['markdown']);
    const result = await getState.execute(
      detail({
        steps: {
          canonical: 'DONE',
          preview: 'DONE',
          markdown: 'SKIPPED',
          analysis: 'PENDING',
          fields: 'PENDING',
          vectorization: 'PENDING',
        },
      }),
    );

    expect(result.pausedSteps).toEqual(['markdown']);
    expect(result.steps.every(({ blockers: stepBlockers }) => stepBlockers.length === 0)).toBe(
      true,
    );
  });

  it('names the parent queue on every pending step without exposing queue settings', async () => {
    await pause([], true);

    const result = await getState.execute(detail());

    expect(result.steps.every(({ blockers: stepBlockers }) => stepBlockers.length === 1)).toBe(
      true,
    );
    expect(blockers(result, 'canonical')).toEqual([
      { kind: 'QUEUE_PAUSED', queue: 'document-process' },
    ]);
    expect(Object.keys(result)).toEqual(['pausedSteps', 'steps']);
  });

  async function pause(pausedSteps: DocumentStep[], queuePaused = false): Promise<void> {
    await settings.write({
      concurrency: {},
      unitConcurrency: 4,
      paused: queuePaused ? ['document-process'] : [],
      pausedSteps,
      services: {},
    });
  }
});

function detail(overrides: Parameters<typeof documentFixture>[0] = {}): DocumentDetail {
  return {
    document: documentFixture(overrides),
    documentType: null,
    people: [],
    subjects: [],
    files: [],
    createdBy: null,
  };
}

function blockers(
  response: Awaited<ReturnType<GetDocumentProcessingState['execute']>>,
  step: DocumentStep,
) {
  return response.steps.find((entry) => entry.step === step)?.blockers ?? [];
}
