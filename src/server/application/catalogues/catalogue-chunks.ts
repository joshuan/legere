import { foldName } from '../../domain/value-objects/name-fold';
import type { CatalogueRow } from '../ports/catalogue-analyst';

// How a catalogue is cut up before it is asked about (docs/05 §5.6c). One call carrying the whole
// catalogue is a prompt that grows with the archive — at 167 people it is 20 KB, and it is what
// tipped a provider into answering 500 — so a reading is several bounded calls whose answers are
// unioned. What is delicate is not the cutting but the *order*: by name, `ШЕРШНЕВ ЕВГЕНИЙ` and
// `SHERSHNEV/EVGENII MR` sit at opposite ends of the list, and a chunking that separates them is a
// chunking that guarantees the one merge this feature exists to propose is never proposed.
//
// So rows are ordered by a **blocking key**: the name read out of Cyrillic into Latin the way search
// already reads it (docs/04 §4.3), and then down to a skeleton the two romanizations share. Both
// spellings above reduce to `evgeni sersnev`, so they are neighbours whatever the cut.

// The Cyrillic letters, read out by the ICAO passport rules — not a choice of taste but the spelling
// printed on this archive's own documents (`SHERSHNEV`, `EVGENII`), and the same mapping
// `transliterate_russian` uses in the search vector. Lowercase only: `foldName` has already been
// applied when this table is consulted.
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'iu',
  я: 'ia',
  // The letters Serbian Cyrillic has and Russian does not, read into their Serbian Latin
  // companions and folded on the spot (`ђ`→`đ`→`d`, `ћ`→`ć`→`c`) — the fold below would do it
  // anyway for every other diacritic.
  ђ: 'd',
  ј: 'j',
  љ: 'lj',
  њ: 'nj',
  ћ: 'c',
  џ: 'dz',
  // And the few Ukrainian and Belarusian letters, so a name in either is read rather than left
  // sitting in Cyrillic inside a Latin word.
  є: 'ie',
  і: 'i',
  ї: 'i',
  ґ: 'g',
  ў: 'u',
};

// The letters no normal form decomposes: everything else loses its marks through NFD.
const UNDECOMPOSED: Readonly<Record<string, string>> = { đ: 'd', ł: 'l', ø: 'o', æ: 'ae', ß: 'ss' };

// Where the two romanizations disagree, and where a typist does. Serbian writes `š`, ICAO writes
// `sh`, and both mean the same letter — so both become `s`. Longest first: `shch` read as `sh`+`ch`
// would leave `sc`.
const REDUCTIONS: readonly (readonly [RegExp, string])[] = [
  [/shch/g, 's'],
  [/sch/g, 's'],
  [/sh/g, 's'],
  [/ch/g, 'c'],
  [/zh/g, 'z'],
  [/kh/g, 'h'],
  [/ts/g, 'c'],
  // `й`/`ј`/`y` are one sound spelled three ways across the mappings, and `ы` reads as `y` while a
  // Latin transcription of the same name will have written `i`.
  [/[jy]/g, 'i'],
];

// Three characters, the same floor `transliterated_twins` uses in the search vector and for the
// same reason: what is shorter is a function word, an initial, or an airline's `MR` — never the
// thing that makes two rows worth comparing.
const MIN_TOKEN_CHARS = 3;

// What two spellings of one name have in common once every alphabet, mark and romanization has been
// argued out of them. Deliberately lossy: this decides who is *compared*, never who is merged —
// `sersnev` colliding with somebody genuinely unrelated costs a place in a chunk and nothing else.
export function blockingKey(name: string): string {
  const latin = [...foldName(name)]
    .map((character) => CYRILLIC_TO_LATIN[character] ?? character)
    .join('');
  const stripped = latin.normalize('NFD').replace(/\p{M}+/gu, '');
  const plain = [...stripped].map((character) => UNDECOMPOSED[character] ?? character).join('');
  const reduced = REDUCTIONS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    plain,
  );
  // A doubled letter is a spelling choice and not a difference: `EVGENII` and `Евгений` part
  // company on nothing else.
  const single = reduced.replace(/([a-z0-9])\1+/g, '$1');

  const tokens = single.split(/[^a-z0-9]+/).filter((token) => token !== '');
  const worth = tokens.filter((token) => token.length >= MIN_TOKEN_CHARS);
  // A catalogue of kinds is full of short words; when nothing clears the floor, everything counts
  // rather than the row keying on the empty string beside every other short one.
  const kept = worth.length === 0 ? tokens : worth;
  // Sorted, because word order is one of the things two spellings of a name disagree about.
  return [...new Set(kept)].sort().join(' ');
}

// The catalogue in the order it will be asked about, cut into chunks no call may exceed. A catalogue
// that fits in one chunk is one chunk *in the order it arrived* — the common instance must not pay
// for the large one, and its prompt is byte-for-byte what it was before chunking existed.
export function chunkCatalogue(
  rows: readonly CatalogueRow[],
  maxRows: number,
): readonly CatalogueRow[][] {
  const cap = Math.max(1, maxRows);
  if (rows.length <= cap) return [[...rows]];

  const ordered = [...rows]
    .map((row) => ({ row, key: blockingKey(row.name), fold: foldName(row.name) }))
    .sort(
      (left, right) =>
        compare(left.key, right.key) ||
        compare(left.fold, right.fold) ||
        compare(left.row.id, right.row.id),
    )
    .map((entry) => entry.row);

  // Chunks of equal size rather than full ones and a remainder: every call is then as small as the
  // cut allows, and the boundaries fall in as few places as possible.
  const count = Math.ceil(ordered.length / cap);
  return Array.from({ length: count }, (_, index) =>
    ordered.slice(
      Math.floor((index * ordered.length) / count),
      Math.floor(((index + 1) * ordered.length) / count),
    ),
  );
}

// Code-unit order, deliberately: `localeCompare` answers differently under different ICU builds, and
// a chunking that depends on the container's locale is a chunking that is not reproducible. The
// blocking key decides; the fold and then the id only break its ties, so that rows sharing a key
// keep a stable order of their own and the same catalogue is always cut in the same places.
function compare(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
