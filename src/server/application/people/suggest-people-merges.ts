import type {
  MergeSuggestionGroup,
  PeopleMergePreviewRequest,
  PeopleMergePreviewResponse,
  PeopleMergeSuggestionsResponse,
} from '../../../shared/contracts/people';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { PersonRepository } from '../../domain/repositories/person.repository';
import { SuggestionCache, sanitizeGroups } from '../catalogues/catalogue-suggestions';
import type { CatalogueAnalyst, CatalogueRow } from '../ports/catalogue-analyst';

const MAX_NAME = 200;

// Which rows of the people catalogue are one person, asked of the analyst and answered from cache
// while nothing changed (docs/05 §5.6c).
export class SuggestPeopleMerges {
  private readonly cache = new SuggestionCache<MergeSuggestionGroup[]>();

  constructor(
    private readonly people: PersonRepository,
    private readonly analyst: CatalogueAnalyst,
  ) {}

  async execute(): Promise<PeopleMergeSuggestionsResponse> {
    // Unconfigured is a state, not an error (docs/07 §7.3): the screen simply has no banner.
    if (!this.analyst.isConfigured) return { state: 'UNCONFIGURED', groups: [] };

    const rows = (await this.people.listActive()).map((person): CatalogueRow => ({
      id: person.id,
      name: person.name,
      note: person.note,
    }));
    // The catalogue's content is the cache key: the same catalogue is the same question, and a
    // changed one asks anew (docs/05 §5.6c).
    const reading = await this.cache.answer(JSON.stringify(rows), async () =>
      sanitizeGroups((await this.analyst.suggestMerges('people', rows)).groups, rows, MAX_NAME).map(
        (group) => ({ ids: group.ids, name: group.name, aka: group.aka }),
      ),
    );
    // A reading that failed says so rather than passing itself off as a catalogue with no
    // duplicates in it (docs/05 §5.6c).
    if (!reading.answered) return { state: 'UNAVAILABLE', groups: [] };
    return { state: 'ANSWERED', groups: reading.value };
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

    if (!this.analyst.isConfigured) return { available: false, name: null, aka: null };

    try {
      const preview = await this.analyst.previewMerge(
        'people',
        rows.map((person) => ({ id: person.id, name: person.name, note: person.note })),
      );
      if (preview === null) return { available: false, name: null, aka: null };
      return { available: true, name: preview.name, aka: preview.aka };
    } catch {
      // The dialog falls back to the raw prefill rather than answering the admin with an error the
      // merge itself never earned (docs/05 §5.4e).
      return { available: false, name: null, aka: null };
    }
  }
}
