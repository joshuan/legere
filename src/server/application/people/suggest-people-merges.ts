import {
  PERSON_NOTE_LIMIT,
  type MergeSuggestionGroup,
  type PeopleMergePreviewRequest,
  type PeopleMergePreviewResponse,
  type PeopleMergeSuggestionsResponse,
} from '../../../shared/contracts/people';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { PersonRepository } from '../../domain/repositories/person.repository';
import { SuggestionCache, cutNote, sanitizeGroups } from '../catalogues/catalogue-suggestions';
import type { CatalogueAnalyst, CatalogueRow } from '../ports/catalogue-analyst';
import type { Clock } from '../ports/clock';

const MAX_NAME = 200;

// Which rows of the people catalogue are one person, asked of the analyst and answered from cache
// while nothing changed (docs/05 §5.6c). `computedAt` dates the cached reading, and `refresh`
// drops it and asks anew — the recompute of docs/11 §11.12a.
export class SuggestPeopleMerges {
  private readonly cache: SuggestionCache<MergeSuggestionGroup[]>;

  constructor(
    private readonly people: PersonRepository,
    private readonly analyst: CatalogueAnalyst,
    clock: Clock,
  ) {
    this.cache = new SuggestionCache(() => clock.now());
  }

  async execute(options?: { refresh?: boolean }): Promise<PeopleMergeSuggestionsResponse> {
    // Unconfigured is a state, not an error (docs/07 §7.3): the screen simply has no banner.
    if (!this.analyst.isConfigured) {
      return { state: 'UNCONFIGURED', computedAt: null, groups: [] };
    }

    const rows = (await this.people.listActive()).map((person): CatalogueRow => ({
      id: person.id,
      name: person.name,
      note: person.note,
    }));
    // The catalogue's content is the cache key: the same catalogue is the same question, and a
    // changed one asks anew (docs/05 §5.6c).
    const reading = await this.cache.answer(
      JSON.stringify(rows),
      async () =>
        sanitizeGroups(
          (await this.analyst.suggestMerges('people', rows)).groups,
          rows,
          MAX_NAME,
          PERSON_NOTE_LIMIT,
        ).map((group) => ({ ids: group.ids, name: group.name, aka: group.aka, note: group.note })),
      options,
    );
    // A reading that failed says so rather than passing itself off as a catalogue with no
    // duplicates in it (docs/05 §5.6c).
    if (!reading.answered) return { state: 'UNAVAILABLE', computedAt: null, groups: [] };
    return {
      state: 'ANSWERED',
      computedAt: reading.computedAt.toISOString(),
      groups: reading.value,
    };
  }
}

// The same reading for rows an admin picked by hand, so the merge dialog opens tidy
// (docs/11 §11.12a). `available: false` sends the dialog back to its raw prefill — an unconfigured
// analyst, an unreadable answer and a provider outage all degrade the same way.
export class PreviewPeopleMerge {
  constructor(
    private readonly people: PersonRepository,
    private readonly analyst: CatalogueAnalyst,
  ) {}

  async execute(input: PeopleMergePreviewRequest): Promise<PeopleMergePreviewResponse> {
    const rows = await this.people.findByIds(input.ids);
    if (rows.length !== input.ids.length) {
      throw new NotFoundError('PERSON_NOT_FOUND', 'Person not found');
    }

    if (!this.analyst.isConfigured) return { available: false, name: null, aka: null, note: null };

    try {
      const preview = await this.analyst.previewMerge(
        'people',
        rows.map((person) => ({ id: person.id, name: person.name, note: person.note })),
      );
      if (preview === null) return { available: false, name: null, aka: null, note: null };
      // The composed note of docs/05 §5.6c, within the note's own contract limit: what does not
      // fit is cut from the end (docs/11 §11.12a).
      return {
        available: true,
        name: preview.name,
        aka: preview.aka,
        note: cutNote(preview.note, PERSON_NOTE_LIMIT),
      };
    } catch {
      // The dialog falls back to the raw prefill rather than answering the admin with an error the
      // merge itself never earned (docs/05 §5.4e).
      return { available: false, name: null, aka: null, note: null };
    }
  }
}
