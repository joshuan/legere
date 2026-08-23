import type {
  MergeSuggestionGroup,
  PeopleMergePreviewRequest,
  PeopleMergePreviewResponse,
  PeopleMergeSuggestionsResponse,
} from '../../../shared/contracts/people';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { PersonRepository } from '../../domain/repositories/person.repository';
import type { CatalogueAnalyst, CatalogueRow, MergeSuggestion } from '../ports/catalogue-analyst';

// The merge contract's own bounds (docs/07 §7.3): a group the merge endpoint would refuse is not a
// suggestion, and a suggester that proposes merging the whole catalogue is answering a different
// question (docs/05 §5.6c).
const MAX_GROUPS = 20;
const MAX_GROUP_IDS = 50;

// Which rows of the people catalogue are one person, asked of the analyst and answered from cache
// while nothing changed (docs/05 §5.6c). Nothing is stored and a refusal is not remembered — the
// one concession to cost is this in-process cache, keyed by the catalogue's content, gone with the
// process.
export class SuggestPeopleMerges {
  private cached: { key: string; groups: MergeSuggestionGroup[] } | null = null;
  // 🔒 Concurrent requests are deduplicated: two admins arriving together are one question to the
  // provider, not two (the same discipline as `CheckExternalServices`).
  private pending: { key: string; answer: Promise<MergeSuggestionGroup[]> } | null = null;

  constructor(
    private readonly people: PersonRepository,
    private readonly analyst: CatalogueAnalyst,
  ) {}

  async execute(): Promise<PeopleMergeSuggestionsResponse> {
    // Unconfigured is an answer, not an error (docs/07 §7.3): the screen simply has no banner.
    if (!this.analyst.isConfigured) return { configured: false, groups: [] };

    const rows = (await this.people.listActive()).map((person): CatalogueRow => ({
      id: person.id,
      name: person.name,
      note: person.note,
    }));
    // The catalogue's content is the cache key: the same catalogue is the same question, and a
    // changed one asks anew (docs/05 §5.6c).
    const key = JSON.stringify(rows);

    if (this.cached?.key === key) return { configured: true, groups: this.cached.groups };
    if (this.pending?.key === key) return { configured: true, groups: await this.pending.answer };

    const answer = this.ask(rows, key);
    this.pending = { key, answer };
    return { configured: true, groups: await answer };
  }

  private async ask(rows: CatalogueRow[], key: string): Promise<MergeSuggestionGroup[]> {
    try {
      const groups = sanitizeSuggestions(await this.analyst.suggestMerges(rows), rows);
      this.cached = { key, groups };
      return groups;
    } catch {
      // An outage is not a verdict (docs/05 §5.4e): the banner is simply absent this visit, and the
      // next request asks again rather than remembering a failure as an answer.
      return [];
    } finally {
      if (this.pending?.key === key) this.pending = null;
    }
  }
}

// The sense half of the checking (docs/06 §6.3.3): the adapter bounded the shape, this judges the
// answer against the living catalogue. An id the model made up, a group of one, a row claimed by
// two groups — dropped, without costing the groups beside them.
export function sanitizeSuggestions(
  suggestions: readonly MergeSuggestion[],
  rows: readonly CatalogueRow[],
): MergeSuggestionGroup[] {
  const living = new Set(rows.map((row) => row.id));
  const claimed = new Set<string>();
  const groups: MergeSuggestionGroup[] = [];

  for (const suggestion of suggestions) {
    const ids = [...new Set(suggestion.ids)]
      .filter((id) => living.has(id) && !claimed.has(id))
      .slice(0, MAX_GROUP_IDS);
    if (ids.length < 2) continue;

    for (const id of ids) claimed.add(id);
    groups.push({ ids, name: suggestion.name, aka: suggestion.aka });
    if (groups.length === MAX_GROUPS) break;
  }
  return groups;
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
