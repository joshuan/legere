// The duplicate-noticer of the catalogues (docs/05 §5.6c): the analyst — the same provider and
// model that read the names off the documents — asked which living rows are one entry. Unlike the
// deterministic suggesters of §5.6a and §5.6b, the sameness here is linguistic: case, diacritics,
// two scripts, transliteration, typos, initials, honorifics glued onto a name. One port serves all
// three catalogues; the subjects call is the one whose rows carry kinds.

// Which of the three catalogues is being read. One port and one provider serve all of them, so a
// failure that does not name its question is not something an operator can act on (docs/06 §6.7) —
// this is what puts the catalogue in the log line beside the service and the model.
export const CATALOGUE_NAMES = ['people', 'subjects', 'subject-kinds'] as const;
export type CatalogueName = (typeof CATALOGUE_NAMES)[number];

// A row as the suggester reads it: what documents call the entry, and the note that tells two of a
// name apart (docs/03 §3.3.19). `kind` travels on the catalogue that has kinds — present on every
// row or on none — because a duplicate thing may sit across two spellings of one kind
// (docs/03 §3.3.20).
export type CatalogueRow = {
  id: string;
  name: string;
  note: string | null;
  kind?: string;
};

// One entry the model believes it recognised: which rows, the spelling worth keeping, the distinct
// other spellings worth remembering in the survivor's note — and, when the rows carried kinds, the
// kind the survivor keeps, as a *name* the caller resolves against the kinds the merged rows
// already have (docs/06 §6.3.3).
export type MergeSuggestion = {
  ids: string[];
  name: string;
  aka: string[];
  kind?: string;
};

// What one reading of a catalogue answers (docs/05 §5.6c): the groups, and — on the kind-aware
// call — the placeholders: rows whose name is a kind rather than a thing, analysis noise offered
// for deletion. Rows without kinds answer groups alone.
export type CatalogueSuggestions = {
  groups: MergeSuggestion[];
  placeholders: string[];
};

// What the merge dialog opens with when the rows were picked by hand: the same reading, for a
// selection that is already decided (docs/11 §11.12a).
export type MergePreview = {
  name: string;
  aka: string[];
  kind?: string;
};

// The adapter owns the answer's shape — schema-parsed, lengths capped, a parse failure an empty
// answer rather than an error (docs/06 §6.3.3). What the answer *means* against the living
// catalogue is the caller's to judge: the adapter cannot know which ids are alive by the time the
// answer lands.
export abstract class CatalogueAnalyst {
  abstract readonly isConfigured: boolean;

  // Which of these rows are one entry. One reading, but not necessarily one call: the adapter cuts
  // the catalogue into chunks it can carry and unions their answers (docs/05 §5.6c). An empty
  // answer is a valid answer: a catalogue with no recognisable duplicates, or a model whose answer
  // did not parse. A throw is the reading failing — never an answer of none.
  abstract suggestMerges(
    catalogue: CatalogueName,
    rows: readonly CatalogueRow[],
  ): Promise<CatalogueSuggestions>;

  // The tidy name and spellings for rows somebody already selected. `null` when the answer did not
  // parse — the dialog then falls back to its raw prefill (docs/11 §11.12a).
  abstract previewMerge(
    catalogue: CatalogueName,
    rows: readonly CatalogueRow[],
  ): Promise<MergePreview | null>;
}
