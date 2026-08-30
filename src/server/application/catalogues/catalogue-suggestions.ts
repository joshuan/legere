import type { CatalogueRow, MergeSuggestion } from '../ports/catalogue-analyst';

// The merge contracts' own bounds (docs/07 §7.3): a group the merge endpoint would refuse is not a
// suggestion, and a suggester that proposes merging the whole catalogue is answering a different
// question (docs/05 §5.6c).
export const MAX_GROUPS = 20;
export const MAX_GROUP_IDS = 50;

export type SanitizedGroup = {
  ids: string[];
  name: string;
  aka: string[];
  kind?: string;
  note: string | null;
};

// The prefill respects the note's own limit (docs/11 §11.12a): what does not fit is cut from the
// end, because a prefill the server's own contract would refuse is a bug, not a default. An emptied
// note is no note.
export function cutNote(note: string | undefined, limit: number): string | null {
  const cut = (note ?? '').slice(0, limit).trim();
  return cut === '' ? null : cut;
}

// The sense half of the checking (docs/06 §6.3.3): the adapter bounded the shape, this judges the
// answer against the living catalogue. An id the model made up, a group of one, a row claimed by
// two groups, a name the merge contract would refuse — dropped, without costing the groups beside
// them.
export function sanitizeGroups(
  suggestions: readonly MergeSuggestion[],
  rows: readonly CatalogueRow[],
  maxNameLength: number,
  maxNoteLength: number,
): SanitizedGroup[] {
  const living = new Set(rows.map((row) => row.id));
  const claimed = new Set<string>();
  const groups: SanitizedGroup[] = [];

  for (const suggestion of suggestions) {
    const ids = [...new Set(suggestion.ids)]
      .filter((id) => living.has(id) && !claimed.has(id))
      .slice(0, MAX_GROUP_IDS);
    if (ids.length < 2) continue;
    if (suggestion.name.length > maxNameLength) continue;

    for (const id of ids) claimed.add(id);
    groups.push({
      ids,
      name: suggestion.name,
      aka: suggestion.aka,
      note: cutNote(suggestion.note, maxNoteLength),
      ...(suggestion.kind === undefined ? {} : { kind: suggestion.kind }),
    });
    if (groups.length === MAX_GROUPS) break;
  }
  return groups;
}

// How one reading of a catalogue ended (docs/05 §5.6c). Two outcomes and not one value, because the
// value alone could only ever say "no groups" — which is what an outage and a clean catalogue said
// in the same words for as long as this existed. An answered reading remembers when it was
// computed: a screen that shows an answer owes its reader the answer's age (docs/07 §7.3).
export type CatalogueReading<T> =
  { answered: true; value: T; computedAt: Date } | { answered: false };

// Nothing is stored and a refusal is not remembered (docs/05 §5.6c) — the one concession to cost is
// this in-process cache, keyed by the catalogue's content, gone with the process. 🔒 Concurrent
// requests are deduplicated: two admins arriving together are one question to the provider, not two
// (the same discipline as `CheckExternalServices`).
export class SuggestionCache<T> {
  private cached: { key: string; value: T; computedAt: Date } | null = null;
  private pending: { key: string; value: Promise<CatalogueReading<T>> } | null = null;

  constructor(private readonly now: () => Date) {}

  async answer(
    key: string,
    compute: () => Promise<T>,
    options?: { refresh?: boolean },
  ): Promise<CatalogueReading<T>> {
    // The reader who distrusts the cached reading recomputes on demand (docs/05 §5.6c): the cache
    // is dropped whole and the question asked anew. A computation already in flight *is* anew —
    // two admins pressing Recompute together stay one question to the provider.
    if (options?.refresh === true) this.cached = null;

    if (this.cached?.key === key) {
      return { answered: true, value: this.cached.value, computedAt: this.cached.computedAt };
    }
    if (this.pending?.key === key) return this.pending.value;

    const value = this.run(key, compute);
    this.pending = { key, value };
    return value;
  }

  private async run(key: string, compute: () => Promise<T>): Promise<CatalogueReading<T>> {
    try {
      const value = await compute();
      // Stamped when the answer lands, not when the question left: what the screen dates is the
      // reading it is showing (docs/07 §7.3).
      const computedAt = this.now();
      this.cached = { key, value, computedAt };
      return { answered: true, value, computedAt };
    } catch {
      // An outage is not a verdict (docs/05 §5.4e), and it is not an answer either: nothing is
      // cached, so the next request asks again — and the caller is told the reading failed rather
      // than handed an emptiness it cannot tell from a clean catalogue. What went wrong is logged
      // where it is known, at the adapter that made the call (docs/06 §6.7).
      return { answered: false };
    } finally {
      if (this.pending?.key === key) this.pending = null;
    }
  }
}
