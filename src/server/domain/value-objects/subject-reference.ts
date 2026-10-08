import type { Subject } from '../entities/subject';

// Recognition is wider than catalogue identity. In particular, Serbian addresses arrive in
// Latin and Cyrillic, with OCR confusing punctuation and diacritics. Nothing here changes the
// stored name or its uniqueness rule.
const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  ђ: 'd',
  е: 'e',
  ж: 'z',
  з: 'z',
  и: 'i',
  ј: 'j',
  к: 'k',
  л: 'l',
  љ: 'lj',
  м: 'm',
  н: 'n',
  њ: 'nj',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  ћ: 'c',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'c',
  џ: 'dz',
  ш: 's',
};

const ADDRESS_WORDS = new Set([
  'beograd',
  'belgrade',
  'grad',
  'ul',
  'ulica',
  'street',
  'stan',
  'st',
  'apartment',
  'apartman',
  'apt',
  'flat',
  'kv',
  'kvartira',
  'дом',
]);

function addressTokens(value: string): string[] {
  const latin = [...value.normalize('NFC').toLowerCase()]
    .map((character) => CYRILLIC[character] ?? character)
    .join('')
    .replaceAll('đ', 'd');
  return latin
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/([0-9])([a-z])/g, '$1 $2')
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function withinOneEdit(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let a = 0;
  let b = 0;
  let edits = 0;
  while (a < left.length && b < right.length) {
    if (left[a] === right[b]) {
      a += 1;
      b += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length >= right.length) a += 1;
    if (right.length >= left.length) b += 1;
  }
  return edits + Number(a < left.length || b < right.length) <= 1;
}

function addressIn(reference: string, candidate: string): boolean {
  const expected = addressTokens(candidate);
  const words = expected.filter((token) => token.length >= 4 && !ADDRESS_WORDS.has(token));
  const numbers = expected.filter((token) => /^\d+$/.test(token));
  // Two street words and a building/unit pair are needed before a fuzzy result can write a link.
  if (words.length < 2 || numbers.length < 2) return false;
  const actualTokens = addressTokens(reference);
  const actual = new Set(actualTokens);
  const hasExactStreetWord = words.some((word) => actual.has(word));
  return (
    hasExactStreetWord &&
    words.every(
      (word) =>
        actual.has(word) ||
        (word.length >= 6 && actualTokens.some((token) => withinOneEdit(word, token))),
    ) &&
    numbers.slice(0, 2).every((number) => actual.has(number))
  );
}

function knownSpellings(subject: Subject): string[] {
  const note = subject.note ?? '';
  const alternate = note
    .split(/\n|;|(?:также известно как|also known as|aka)\s*:/gi)
    .map((part) => part.trim())
    .filter(Boolean);
  return [subject.name, ...alternate];
}

// A score-free answer: several matches mean that this evidence does not identify one subject.
// The analyst's proposal and, for invoices, its title can both be used as the reference.
export function findUniqueSubjectByAddress<T extends Subject>(
  reference: string,
  subjects: readonly T[],
): T | null {
  const matches = subjects.filter((subject) =>
    knownSpellings(subject).some((spelling) => addressIn(reference, spelling)),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
