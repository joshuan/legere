import { fieldSchemaFor } from '../../../shared/contracts/document-fields';
import type { Document } from './document';

// The unordered pair, spelled one way (docs/03 §3.3.23): a_id < b_id always, so one edge cannot
// exist twice in two spellings and the unique index sees every attempt at a duplicate.
export type OrderedPair = { aId: string; bId: string };

export function orderedPair(one: string, other: string): OrderedPair {
  return one < other ? { aId: one, bId: other } : { aId: other, bId: one };
}

// How many identifiers a document is probed by, and how much of its text is read for them
// (docs/05 §5.6b). A handful, the most distinctive first — a probe is one FTS query.
const MAX_PROBES = 8;
const OPENING_CHARS = 4000;
// A run of letters/digits with the punctuation document numbers actually carry: "12-2019",
// "№ 745/22" (the № splits off), "AB1234567", "PIB 02345678".
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}/№–-]{3,}/gu;

// The identifiers this document visibly carries (docs/05 §5.6b): the searchable extracted string
// values that hold a digit first — a document number is the archetype — then number-bearing tokens
// of the title and the opening of the text. A bare year is excluded, because "2019" links half the
// archive to the other half; so is a short run of digits, which is a price or a page number.
export function linkProbeTokens(
  document: Pick<Document, 'title' | 'markdown' | 'extracted'>,
): string[] {
  const seen = new Set<string>();
  const probes: string[] = [];

  const take = (raw: string): void => {
    if (probes.length >= MAX_PROBES) return;
    const token = raw.trim();
    if (token.length < 4) return;
    if (!/\p{N}/u.test(token)) return;
    if (/^(19|20)\d{2}$/.test(token)) return;
    if (/^\p{N}+$/u.test(token) && token.length < 5) return;
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    probes.push(token);
  };

  const extracted = document.extracted;
  if (extracted !== null) {
    const schema = fieldSchemaFor(extracted.schema.slug);
    for (const spec of schema?.fields ?? []) {
      if (spec.searchable !== true || spec.kind !== 'string') continue;
      const value = extracted.values[spec.key];
      if (typeof value === 'string') take(value);
    }
  }
  for (const source of [document.title, (document.markdown ?? '').slice(0, OPENING_CHARS)]) {
    for (const match of source.matchAll(TOKEN)) take(match[0]);
  }
  return probes;
}
