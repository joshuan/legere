// The duplicate-noticer of the people catalogue (docs/05 §5.6c): the analyst — the same provider
// and model that read the names off the documents — asked which living rows are one person. Unlike
// the deterministic suggesters of §5.6a and §5.6b, the sameness here is linguistic: case,
// diacritics, two scripts, transliteration, typos, initials, honorifics glued onto a name.

// A row as the suggester reads it: what documents call somebody, and the note that tells two people
// of the same name apart (docs/03 §3.3.19) — a shared name with distinct notes is a reason to keep
// quiet, so the note is part of the question.
export type CatalogueRow = {
  id: string;
  name: string;
  note: string | null;
};

// One person the model believes it recognised: which rows, the spelling worth keeping, and the
// distinct other spellings worth remembering in the survivor's note.
export type MergeSuggestion = {
  ids: string[];
  name: string;
  aka: string[];
};

// What the merge dialog opens with when the rows were picked by hand: the same reading, for a
// selection that is already decided (docs/11 §11.12a).
export type MergePreview = {
  name: string;
  aka: string[];
};

// The adapter owns the answer's shape — schema-parsed, lengths capped, a parse failure an empty
// answer rather than an error (docs/06 §6.3.3). What the answer *means* against the living
// catalogue is the caller's to judge: the adapter cannot know which ids are alive by the time the
// answer lands.
export abstract class CatalogueAnalyst {
  abstract readonly isConfigured: boolean;

  // Which of these rows are one person. An empty answer is a valid answer: a catalogue with no
  // recognisable duplicates, or a model whose answer did not parse.
  abstract suggestMerges(rows: readonly CatalogueRow[]): Promise<MergeSuggestion[]>;

  // The tidy name and spellings for rows somebody already selected. `null` when the answer did not
  // parse — the dialog then falls back to its raw prefill (docs/11 §11.12a).
  abstract previewMerge(rows: readonly CatalogueRow[]): Promise<MergePreview | null>;
}
