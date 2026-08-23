// The identity fold of the catalogues (docs/03 §3.3.19): what makes two spellings of a name "the
// same name" for uniqueness and matching. The database cannot be trusted with this — its collation
// is `C`, whose lower() folds ASCII alone, which is how ШЕРШНЕВ and Шершнев lived side by side —
// so the fold is computed here, stored beside the name, and asked on every lookup.
//
// Deliberately narrow: Unicode case, composed form, and whitespace. Diacritics, transliteration
// and typos are *recognition*, not identity — two names differing by an accent may genuinely be
// two people, and folding them together here would merge what only a person may merge. That work
// belongs to the suggesters (docs/05 §5.6c), which propose and never decide.
export function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}
