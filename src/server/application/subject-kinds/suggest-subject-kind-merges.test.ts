import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../../../test/helpers/fakes';
import { InMemorySubjectKindRepository } from '../../../../test/helpers/processing-fakes';
import { NotFoundError } from '../../domain/errors/domain-error';
import type {
  CatalogueName,
  CatalogueRow,
  CatalogueSuggestions,
  MergePreview,
} from '../ports/catalogue-analyst';
import { CatalogueAnalyst } from '../ports/catalogue-analyst';
import { PreviewSubjectKindMerge, SuggestSubjectKindMerges } from './suggest-subject-kind-merges';

class ScriptedAnalyst extends CatalogueAnalyst {
  calls = 0;
  configured = true;
  answer: CatalogueSuggestions = { groups: [], placeholders: [] };
  preview: MergePreview | null = null;
  asked: CatalogueName[] = [];
  failure: Error | null = null;

  get isConfigured(): boolean {
    return this.configured;
  }

  suggestMerges(
    catalogue: CatalogueName,
    rows: readonly CatalogueRow[],
  ): Promise<CatalogueSuggestions> {
    void rows;
    this.calls += 1;
    this.asked.push(catalogue);
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(this.answer);
  }

  previewMerge(
    catalogue: CatalogueName,
    rows: readonly CatalogueRow[],
  ): Promise<MergePreview | null> {
    void catalogue;
    void rows;
    return Promise.resolve(this.preview);
  }
}

async function seeded(): Promise<InMemorySubjectKindRepository> {
  const kinds = new InMemorySubjectKindRepository();
  await kinds.create({ name: 'жильё' });
  await kinds.create({ name: 'Жильё' });
  return kinds;
}

describe('SuggestSubjectKindMerges', () => {
  it('answers the analyst groups, cached until the catalogue changes', async () => {
    const kinds = await seeded();
    const analyst = new ScriptedAnalyst();
    analyst.answer = {
      groups: [{ ids: ['kind-1', 'kind-2'], name: 'жильё', aka: ['Жильё'] }],
      placeholders: [],
    };
    const suggest = new SuggestSubjectKindMerges(kinds, analyst, new FixedClock());

    const first = await suggest.execute();
    expect(first).toEqual({
      state: 'ANSWERED',
      computedAt: '2026-01-01T12:00:00.000Z',
      groups: [{ ids: ['kind-1', 'kind-2'], name: 'жильё', aka: ['Жильё'], note: null }],
    });
    expect(analyst.asked).toEqual(['subject-kinds']);
    await suggest.execute();
    expect(analyst.calls).toBe(1);

    await kinds.create({ name: 'car' });
    await suggest.execute();
    expect(analyst.calls).toBe(2);
  });

  it('drops a group whose name the kinds merge contract would refuse', async () => {
    const kinds = await seeded();
    const analyst = new ScriptedAnalyst();
    analyst.answer = {
      groups: [{ ids: ['kind-1', 'kind-2'], name: 'a'.repeat(41), aka: [] }],
      placeholders: [],
    };

    await expect(
      new SuggestSubjectKindMerges(kinds, analyst, new FixedClock()).execute(),
    ).resolves.toEqual({
      state: 'ANSWERED',
      computedAt: '2026-01-01T12:00:00.000Z',
      groups: [],
    });
  });

  it('answers UNCONFIGURED without asking an unconfigured analyst', async () => {
    const analyst = new ScriptedAnalyst();
    analyst.configured = false;

    await expect(
      new SuggestSubjectKindMerges(await seeded(), analyst, new FixedClock()).execute(),
    ).resolves.toEqual({
      state: 'UNCONFIGURED',
      computedAt: null,
      groups: [],
    });
    expect(analyst.calls).toBe(0);
  });

  it('answers UNAVAILABLE when the analyst could not be asked, and asks again next time', async () => {
    const kinds = await seeded();
    const analyst = new ScriptedAnalyst();
    analyst.failure = new Error('provider is away');
    const suggest = new SuggestSubjectKindMerges(kinds, analyst, new FixedClock());

    await expect(suggest.execute()).resolves.toEqual({
      state: 'UNAVAILABLE',
      computedAt: null,
      groups: [],
    });
    await expect(suggest.execute()).resolves.toEqual({
      state: 'UNAVAILABLE',
      computedAt: null,
      groups: [],
    });
    // A failure is not cached (docs/05 §5.4e): the same catalogue was asked about twice.
    expect(analyst.calls).toBe(2);
  });
});

describe('PreviewSubjectKindMerge', () => {
  it('answers the tidy reading, and refuses a name past the contract', async () => {
    const kinds = await seeded();
    const analyst = new ScriptedAnalyst();
    analyst.preview = { name: 'жильё', aka: ['Жильё'] };
    const preview = new PreviewSubjectKindMerge(kinds, analyst);

    await expect(preview.execute({ ids: ['kind-1', 'kind-2'] })).resolves.toEqual({
      available: true,
      name: 'жильё',
      aka: ['Жильё'],
      note: null,
    });

    // A 41-character kind is one the merge endpoint would refuse (docs/07 §7.3).
    analyst.preview = { name: 'a'.repeat(41), aka: [] };
    await expect(preview.execute({ ids: ['kind-1', 'kind-2'] })).resolves.toEqual({
      available: false,
      name: null,
      aka: null,
      note: null,
    });
  });

  it('refuses an id that is not a living kind', async () => {
    const preview = new PreviewSubjectKindMerge(await seeded(), new ScriptedAnalyst());
    await expect(preview.execute({ ids: ['kind-1', 'missing'] })).rejects.toThrowError(
      NotFoundError,
    );
  });
});
