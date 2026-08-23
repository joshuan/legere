import { describe, expect, it } from 'vitest';
import {
  InMemorySubjectKindRepository,
  InMemorySubjectRepository,
} from '../../../../test/helpers/processing-fakes';
import type { CatalogueRow, CatalogueSuggestions, MergePreview } from '../ports/catalogue-analyst';
import { CatalogueAnalyst } from '../ports/catalogue-analyst';
import { PreviewSubjectMerge, SuggestSubjectMerges } from './suggest-subject-merges';

class ScriptedAnalyst extends CatalogueAnalyst {
  answer: CatalogueSuggestions = { groups: [], placeholders: [] };
  preview: MergePreview | null = null;
  lastRows: CatalogueRow[] = [];

  get isConfigured(): boolean {
    return true;
  }

  suggestMerges(rows: readonly CatalogueRow[]): Promise<CatalogueSuggestions> {
    this.lastRows = [...rows];
    return Promise.resolve(this.answer);
  }

  previewMerge(rows: readonly CatalogueRow[]): Promise<MergePreview | null> {
    this.lastRows = [...rows];
    return Promise.resolve(this.preview);
  }
}

// The shelves of docs/03 §3.3.20: one car under `car` and under `автомобиль`.
async function seeded() {
  const kinds = new InMemorySubjectKindRepository();
  const subjects = new InMemorySubjectRepository(kinds);
  const car = await kinds.create({ name: 'car' });
  const avto = await kinds.create({ name: 'автомобиль' });
  const lacettiCar = await subjects.create({ kindId: car.id, name: 'CHEVROLET LACETTI' });
  const lacettiAvto = await subjects.create({ kindId: avto.id, name: 'Chevrolet Lacetti' });
  const placeholder = await subjects.create({ kindId: avto.id, name: 'автомобиль' });
  return { kinds, subjects, car, avto, lacettiCar, lacettiAvto, placeholder };
}

describe('SuggestSubjectMerges', () => {
  it('resolves the survivor kind to one the merged rows already have, and drops a group that cannot', async () => {
    const { subjects, avto, lacettiCar, lacettiAvto, placeholder } = await seeded();
    const analyst = new ScriptedAnalyst();
    analyst.answer = {
      groups: [
        {
          // The model echoes the kind in another case: the fold resolves it (docs/03 §3.3.20).
          ids: [lacettiCar.id, lacettiAvto.id],
          name: 'Chevrolet Lacetti',
          kind: 'АВТОМОБИЛЬ',
          aka: ['CHEVROLET LACETTI'],
        },
        {
          // A kind no grouped row carries is a merge the endpoint would refuse — dropped whole.
          ids: [lacettiAvto.id, placeholder.id],
          name: 'Chevrolet Lacetti',
          kind: 'жильё',
          aka: [],
        },
      ],
      placeholders: [],
    };

    const response = await new SuggestSubjectMerges(subjects, analyst).execute();

    expect(response.groups).toEqual([
      {
        ids: [lacettiCar.id, lacettiAvto.id],
        name: 'Chevrolet Lacetti',
        kindId: avto.id,
        aka: ['CHEVROLET LACETTI'],
      },
    ]);
    // The rows travelled with their kinds, or the model could not have judged the shelf.
    expect(analyst.lastRows.every((row) => row.kind !== undefined)).toBe(true);
  });

  it('passes the placeholder rows that are living things, and drops the made-up ones', async () => {
    const { subjects, placeholder } = await seeded();
    const analyst = new ScriptedAnalyst();
    analyst.answer = { groups: [], placeholders: [placeholder.id, 'made-up'] };

    const response = await new SuggestSubjectMerges(subjects, analyst).execute();

    expect(response.placeholders).toEqual([placeholder.id]);
  });
});

describe('PreviewSubjectMerge', () => {
  it('answers the tidy reading with the kind resolved, and keeps the name when the kind is not', async () => {
    const { subjects, avto, lacettiCar, lacettiAvto } = await seeded();
    const analyst = new ScriptedAnalyst();
    analyst.preview = {
      name: 'Chevrolet Lacetti',
      kind: 'автомобиль',
      aka: ['CHEVROLET LACETTI'],
    };
    const preview = new PreviewSubjectMerge(subjects, analyst);

    await expect(preview.execute({ ids: [lacettiCar.id, lacettiAvto.id] })).resolves.toEqual({
      available: true,
      name: 'Chevrolet Lacetti',
      kindId: avto.id,
      aka: ['CHEVROLET LACETTI'],
    });

    // An unresolvable kind costs the kind, not the preview (docs/07 §7.3).
    analyst.preview = { name: 'Chevrolet Lacetti', kind: 'boat', aka: [] };
    await expect(preview.execute({ ids: [lacettiCar.id, lacettiAvto.id] })).resolves.toEqual({
      available: true,
      name: 'Chevrolet Lacetti',
      kindId: null,
      aka: [],
    });
  });
});
