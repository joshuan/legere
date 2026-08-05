import { francAll } from 'franc-min';

// What a document is written in, as BCP-47 with a script subtag where the script is not implied:
// `ru`, `en`, `sr-Latn`. Serbian is the reason the subtag exists — the same language is written in
// both Cyrillic and Latin, and tesseract needs to be told which (docs/03 §3.3.10).
export type DocumentLanguage = string;

// Below this the detector is guessing. Measured, not assumed: on 160 characters of Russian, franc
// ranks Bulgarian first (1.00) with Russian second (0.97); at 450 characters Russian wins outright.
// Real documents are far longer than this, and for the ones that are not, no answer beats a wrong
// one — nothing downstream is worse off with an empty list.
const MIN_CHARS = 200;

// A second language is judged on less: by then the text as a whole has already proved itself, and a
// parallel column — the reason this feature exists — is often shorter than the original.
const MIN_PART_CHARS = 80;
// A second language has to actually be there — a stray English line in a Russian contract is not a
// second language, a full parallel column is.
const MIN_SHARE = 0.2;
const MAX_LANGUAGES = 3;

// franc speaks ISO 639-3; the product speaks BCP-47, and so do people.
const TO_BCP47: Readonly<Record<string, string>> = {
  rus: 'ru',
  eng: 'en',
  srp: 'sr',
  ukr: 'uk',
  deu: 'de',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  pol: 'pl',
  tur: 'tr',
  bul: 'bg',
  bel: 'be',
  ces: 'cs',
  nld: 'nl',
  por: 'pt',
  ron: 'ro',
  hrv: 'hr',
  bos: 'bs',
  slk: 'sk',
  slv: 'sl',
};

// Languages that exist in both scripts, so the subtag carries information rather than noise.
const BISCRIPTAL = new Set(['sr', 'bs']);

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;

// The languages of a text, most likely first. Pure and offline: an n-gram detector plus the scripts
// the text is actually written in — no model to download, nothing to configure.
export function detectLanguages(text: string): DocumentLanguage[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < MIN_CHARS) return [];

  const byScript = splitByScript(clean);
  const found: DocumentLanguage[] = [];

  for (const [script, part] of byScript) {
    if (part.length < MIN_PART_CHARS || part.length / clean.length < MIN_SHARE) continue;

    for (const [code] of francAll(part).slice(0, 2)) {
      const language = TO_BCP47[code];
      if (language === undefined) continue;
      const tagged = BISCRIPTAL.has(language) ? `${language}-${script}` : language;
      if (!found.includes(tagged)) found.push(tagged);
      break;
    }
  }

  return found.slice(0, MAX_LANGUAGES);
}

// A bilingual document is usually bi-script too, and running the detector over the whole text lets
// the longer half win outright. Splitting first is what finds both.
function splitByScript(text: string): Map<'Cyrl' | 'Latn', string> {
  const parts = new Map<'Cyrl' | 'Latn', string[]>([
    ['Cyrl', []],
    ['Latn', []],
  ]);

  for (const word of text.split(' ')) {
    if (CYRILLIC.test(word)) parts.get('Cyrl')?.push(word);
    else if (LATIN.test(word)) parts.get('Latn')?.push(word);
  }

  return new Map([...parts].map(([script, words]) => [script, words.join(' ')] as const));
}

// BCP-47 as the product stores it → the codes tesseract knows. Serbian is the case that needs the
// script: `srp` is Cyrillic, `srp_latn` is not, and giving the wrong one costs every diacritic.
const TESSERACT_CODES: Readonly<Record<string, string>> = {
  ru: 'rus',
  en: 'eng',
  uk: 'ukr',
  bg: 'bul',
  de: 'deu',
  fr: 'fra',
  es: 'spa',
  it: 'ita',
  pl: 'pol',
  tr: 'tur',
  'sr-Cyrl': 'srp',
  'sr-Latn': 'srp_latn',
  sr: 'srp',
  hr: 'srp_latn',
  bs: 'srp_latn',
};

// Which languages an OCR pass is given: the document's own once they are known, the instance
// default before that. A wrong set costs accuracy — `EUR` read with Cyrillic in the set comes back
// as `ЕОВ` — so a narrow set beats a broad one (docs/03 §3.3.10).
export function ocrLanguagesOf(
  documentLanguages: readonly string[],
  fallback: readonly string[],
): string[] {
  const own = documentLanguages.flatMap((language) => {
    const code = TESSERACT_CODES[language];
    return code === undefined ? [] : [code];
  });
  return own.length > 0 ? own : [...fallback];
}
