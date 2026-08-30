import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../../../test/helpers/fakes';
import { InMemoryPersonRepository } from '../../../../test/helpers/processing-fakes';
import { NotFoundError } from '../../domain/errors/domain-error';
import type {
  CatalogueName,
  CatalogueRow,
  CatalogueSuggestions,
  MergePreview,
  MergeSuggestion,
} from '../ports/catalogue-analyst';
import { CatalogueAnalyst } from '../ports/catalogue-analyst';
import { PreviewPeopleMerge, SuggestPeopleMerges } from './suggest-people-merges';

// The analyst as the use case sees it: a scripted answer and a count of questions asked, so a test
// can say both what came back and whether the provider was bothered at all (docs/05 §5.6c).
class ScriptedAnalyst extends CatalogueAnalyst {
  calls = 0;
  previews = 0;
  configured = true;
  answer: MergeSuggestion[] = [];
  preview: MergePreview | null = null;
  failure: Error | null = null;
  asked: CatalogueName[] = [];

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
    return Promise.resolve({ groups: this.answer, placeholders: [] });
  }

  previewMerge(
    catalogue: CatalogueName,
    rows: readonly CatalogueRow[],
  ): Promise<MergePreview | null> {
    void catalogue;
    void rows;
    this.previews += 1;
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(this.preview);
  }
}

// The FixedClock's own epoch, spelled out where the assertions compare against it.
const T0 = '2026-01-01T12:00:00.000Z';

async function seeded(names: string[]): Promise<InMemoryPersonRepository> {
  const people = new InMemoryPersonRepository();
  for (const name of names) await people.create({ name });
  return people;
}

describe('SuggestPeopleMerges', () => {
  it('answers UNCONFIGURED without asking anything of an unconfigured analyst', async () => {
    const analyst = new ScriptedAnalyst();
    analyst.configured = false;
    const suggest = new SuggestPeopleMerges(await seeded(['A', 'B']), analyst, new FixedClock());

    await expect(suggest.execute()).resolves.toEqual({
      state: 'UNCONFIGURED',
      computedAt: null,
      groups: [],
    });
    expect(analyst.calls).toBe(0);
  });

  it('names the catalogue it is reading, so a failure can say which one broke', async () => {
    const analyst = new ScriptedAnalyst();
    await new SuggestPeopleMerges(await seeded(['A', 'B']), analyst, new FixedClock()).execute();

    expect(analyst.asked).toEqual(['people']);
  });

  it('drops what the model made up: unknown ids, groups of one, a row claimed twice; caps the groups at twenty', async () => {
    const people = await seeded(Array.from({ length: 60 }, (_, index) => `Person ${index + 1}`));
    const analyst = new ScriptedAnalyst();
    analyst.answer = [
      // An id that is not a living row costs the id, and with it the group falls under two.
      { ids: ['person-1', 'made-up'], name: 'Person 1', aka: [] },
      // A group of one is not a merge.
      { ids: ['person-2'], name: 'Person 2', aka: [] },
      // A row already claimed belongs to the first group that named it.
      { ids: ['person-3', 'person-4'], name: 'Person 3', aka: ['Person 4'] },
      { ids: ['person-4', 'person-5'], name: 'Person 4', aka: [] },
      // Twenty-two well-formed groups arrive; twenty pass.
      ...Array.from({ length: 22 }, (_, index): MergeSuggestion => {
        const first = 6 + index * 2;
        return {
          ids: [`person-${first}`, `person-${first + 1}`],
          name: `Person ${first}`,
          aka: [`Person ${first + 1}`],
        };
      }),
    ];
    const suggest = new SuggestPeopleMerges(people, analyst, new FixedClock());

    const response = await suggest.execute();

    expect(response.state).toBe('ANSWERED');
    expect(response.groups[0]).toEqual({
      ids: ['person-3', 'person-4'],
      name: 'Person 3',
      aka: ['Person 4'],
      note: null,
    });
    // person-4 was spoken for, so the group that named it again fell under two rows.
    expect(response.groups.some((group) => group.ids.includes('person-5'))).toBe(false);
    expect(response.groups).toHaveLength(20);
  });

  it('carries the composed note of a group through, cut to the note contract limit', async () => {
    const people = await seeded(['A', 'B']);
    const analyst = new ScriptedAnalyst();
    analyst.answer = [
      {
        ids: ['person-1', 'person-2'],
        name: 'A',
        aka: ['B'],
        note: `keep this. ${'x'.repeat(600)}`,
      },
    ];
    const suggest = new SuggestPeopleMerges(people, analyst, new FixedClock());

    const response = await suggest.execute();

    const note = response.groups[0]?.note;
    expect(note?.startsWith('keep this.')).toBe(true);
    // The people note limit (docs/07 §7.3): what does not fit is cut from the end (docs/11 §11.12a).
    expect(note).toHaveLength(500);
  });

  it('asks once for one catalogue, and again when it changes', async () => {
    const people = await seeded(['Marija Petrović', 'Marija Petrovic']);
    const analyst = new ScriptedAnalyst();
    analyst.answer = [
      { ids: ['person-1', 'person-2'], name: 'Marija Petrović', aka: ['Marija Petrovic'] },
    ];
    const suggest = new SuggestPeopleMerges(people, analyst, new FixedClock());

    const first = await suggest.execute();
    const second = await suggest.execute();
    expect(analyst.calls).toBe(1);
    expect(second).toEqual(first);

    // The catalogue changed, so the same question is a new question (docs/05 §5.6c).
    await people.create({ name: 'Marija Petrovič' });
    await suggest.execute();
    expect(analyst.calls).toBe(2);
  });

  it('dates the cached reading when it was computed, not when it was read again', async () => {
    const people = await seeded(['A', 'B']);
    const analyst = new ScriptedAnalyst();
    const clock = new FixedClock();
    const suggest = new SuggestPeopleMerges(people, analyst, clock);

    const first = await suggest.execute();
    expect(first.computedAt).toBe(T0);

    // An hour later the cached answer still says when it was actually computed (docs/07 §7.3).
    clock.advance(60 * 60_000);
    const second = await suggest.execute();
    expect(second.computedAt).toBe(T0);
    expect(analyst.calls).toBe(1);
  });

  it('drops the cached reading on refresh and asks anew, with a fresh date', async () => {
    const people = await seeded(['A', 'B']);
    const analyst = new ScriptedAnalyst();
    const clock = new FixedClock();
    const suggest = new SuggestPeopleMerges(people, analyst, clock);

    await suggest.execute();
    clock.advance(60 * 60_000);

    const recomputed = await suggest.execute({ refresh: true });
    expect(analyst.calls).toBe(2);
    expect(recomputed.computedAt).toBe('2026-01-01T13:00:00.000Z');
  });

  it('keeps the concurrent dedup under refresh: two recomputes together are one question', async () => {
    const people = await seeded(['A', 'B']);
    const analyst = new ScriptedAnalyst();
    const suggest = new SuggestPeopleMerges(people, analyst, new FixedClock());

    const [first, second] = await Promise.all([
      suggest.execute({ refresh: true }),
      suggest.execute({ refresh: true }),
    ]);
    expect(analyst.calls).toBe(1);
    expect(first).toEqual(second);
  });

  it('deduplicates the concurrent askers of one catalogue', async () => {
    const people = await seeded(['A', 'B']);
    const analyst = new ScriptedAnalyst();
    analyst.answer = [{ ids: ['person-1', 'person-2'], name: 'A', aka: ['B'] }];
    const suggest = new SuggestPeopleMerges(people, analyst, new FixedClock());

    const [first, second] = await Promise.all([suggest.execute(), suggest.execute()]);
    expect(analyst.calls).toBe(1);
    expect(first).toEqual(second);
  });

  it('reports an outage as UNAVAILABLE, never as an answer of none', async () => {
    const people = await seeded(['A', 'B']);
    const analyst = new ScriptedAnalyst();
    analyst.failure = new Error('provider is away');
    const suggest = new SuggestPeopleMerges(people, analyst, new FixedClock());

    // 🔒 The whole of M52: this is not `ANSWERED` with an empty list, which is what a dead provider
    // and a clean catalogue used to look like alike (docs/05 §5.6c).
    await expect(suggest.execute()).resolves.toEqual({
      state: 'UNAVAILABLE',
      computedAt: null,
      groups: [],
    });

    // Nothing was cached: the next request asks again rather than remembering the failure.
    analyst.failure = null;
    analyst.answer = [{ ids: ['person-1', 'person-2'], name: 'A', aka: ['B'] }];
    const recovered = await suggest.execute();
    expect(analyst.calls).toBe(2);
    expect(recovered).toEqual({
      state: 'ANSWERED',
      computedAt: T0,
      groups: [{ ids: ['person-1', 'person-2'], name: 'A', aka: ['B'], note: null }],
    });
  });

  it('tells a catalogue with no duplicates from an analyst that could not be asked', async () => {
    const analyst = new ScriptedAnalyst();
    const clean = new SuggestPeopleMerges(await seeded(['A', 'B']), analyst, new FixedClock());

    await expect(clean.execute()).resolves.toEqual({
      state: 'ANSWERED',
      computedAt: T0,
      groups: [],
    });
  });
});

describe('PreviewPeopleMerge', () => {
  it('answers the analyst reading for living rows, the composed note included', async () => {
    const people = await seeded(['SHERSHNEV/EVGENII MR', 'Шершнев Евгений Константинович']);
    const analyst = new ScriptedAnalyst();
    analyst.preview = {
      name: 'Шершнев Евгений Константинович',
      aka: ['SHERSHNEV EVGENII'],
      note: 'Also known as: SHERSHNEV EVGENII.',
    };
    const preview = new PreviewPeopleMerge(people, analyst);

    await expect(preview.execute({ ids: ['person-1', 'person-2'] })).resolves.toEqual({
      available: true,
      name: 'Шершнев Евгений Константинович',
      aka: ['SHERSHNEV EVGENII'],
      note: 'Also known as: SHERSHNEV EVGENII.',
    });
  });

  it('cuts a note past the contract limit from the end, and answers null for none', async () => {
    const people = await seeded(['A', 'B']);
    const analyst = new ScriptedAnalyst();
    analyst.preview = { name: 'A', aka: ['B'], note: 'y'.repeat(700) };
    const preview = new PreviewPeopleMerge(people, analyst);

    const over = await preview.execute({ ids: ['person-1', 'person-2'] });
    expect(over.note).toBe('y'.repeat(500));

    // A preview without a note still opens the dialog — on its raw concatenation.
    analyst.preview = { name: 'A', aka: ['B'] };
    const bare = await preview.execute({ ids: ['person-1', 'person-2'] });
    expect(bare).toEqual({ available: true, name: 'A', aka: ['B'], note: null });
  });

  it('refuses an id that is not a living person', async () => {
    const people = await seeded(['A', 'B']);
    const preview = new PreviewPeopleMerge(people, new ScriptedAnalyst());

    await expect(preview.execute({ ids: ['person-1', 'missing'] })).rejects.toThrowError(
      NotFoundError,
    );
  });

  it('degrades to unavailable when the analyst is unconfigured, silent or away', async () => {
    const people = await seeded(['A', 'B']);
    const unavailable = { available: false, name: null, aka: null, note: null };
    const ids = ['person-1', 'person-2'];

    const unconfigured = new ScriptedAnalyst();
    unconfigured.configured = false;
    await expect(new PreviewPeopleMerge(people, unconfigured).execute({ ids })).resolves.toEqual(
      unavailable,
    );
    expect(unconfigured.previews).toBe(0);

    const silent = new ScriptedAnalyst();
    silent.preview = null;
    await expect(new PreviewPeopleMerge(people, silent).execute({ ids })).resolves.toEqual(
      unavailable,
    );

    const away = new ScriptedAnalyst();
    away.failure = new Error('provider is away');
    await expect(new PreviewPeopleMerge(people, away).execute({ ids })).resolves.toEqual(
      unavailable,
    );
  });
});
