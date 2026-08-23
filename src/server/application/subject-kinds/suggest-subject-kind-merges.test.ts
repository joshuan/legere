import { describe, expect, it } from 'vitest';
import { InMemorySubjectKindRepository } from '../../../../test/helpers/processing-fakes';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { CatalogueRow, CatalogueSuggestions, MergePreview } from '../ports/catalogue-analyst';
import { CatalogueAnalyst } from '../ports/catalogue-analyst';
import { PreviewSubjectKindMerge, SuggestSubjectKindMerges } from './suggest-subject-kind-merges';

class ScriptedAnalyst extends CatalogueAnalyst {
  calls = 0;
  configured = true;
  answer: CatalogueSuggestions = { groups: [], placeholders: [] };
  preview: MergePreview | null = null;

  get isConfigured(): boolean {
    return this.configured;
  }

  suggestMerges(rows: readonly CatalogueRow[]): Promise<CatalogueSuggestions> {
    void rows;
    this.calls += 1;
    return Promise.resolve(this.answer);
  }

  previewMerge(rows: readonly CatalogueRow[]): Promise<MergePreview | null> {
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
    const suggest = new SuggestSubjectKindMerges(kinds, analyst);

    const first = await suggest.execute();
    expect(first).toEqual({
      configured: true,
      groups: [{ ids: ['kind-1', 'kind-2'], name: 'жильё', aka: ['Жильё'] }],
    });
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

    await expect(new SuggestSubjectKindMerges(kinds, analyst).execute()).resolves.toEqual({
      configured: true,
      groups: [],
    });
  });

  it('answers configured: false without asking an unconfigured analyst', async () => {
    const analyst = new ScriptedAnalyst();
    analyst.configured = false;

    await expect(new SuggestSubjectKindMerges(await seeded(), analyst).execute()).resolves.toEqual({
      configured: false,
      groups: [],
    });
    expect(analyst.calls).toBe(0);
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
    });

    // A 41-character kind is one the merge endpoint would refuse (docs/07 §7.3).
    analyst.preview = { name: 'a'.repeat(41), aka: [] };
    await expect(preview.execute({ ids: ['kind-1', 'kind-2'] })).resolves.toEqual({
      available: false,
      name: null,
      aka: null,
    });
  });

  it('refuses an id that is not a living kind', async () => {
    const preview = new PreviewSubjectKindMerge(await seeded(), new ScriptedAnalyst());
    await expect(preview.execute({ ids: ['kind-1', 'missing'] })).rejects.toThrowError(
      NotFoundError,
    );
  });
});
