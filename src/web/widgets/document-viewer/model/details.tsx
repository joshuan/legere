'use client';

import Link from 'next/link';
import { type ReactNode } from 'react';
import {
  type DocumentDetailDto,
  type DocumentResetEntry,
  type DocumentStep,
} from '../../../../shared/contracts/documents';
import {
  moneyValueSchema,
  type DocumentFieldSpec,
} from '../../../../shared/contracts/document-fields';
import { pageFormatSchema, type PageFormat } from '../../../../shared/contracts/enums';
import { isRecord } from './events';

export type MetaChange = {
  title?: string;
  description?: string | null;
  typeId?: string | null;
  languages?: string[];
  country?: string | null;
  city?: string | null;
  peopleIds?: string[];
  subjectIds?: string[];
  documentDate?: string | null;
  pageFormat?: PageFormat;
  // The typed fields of the document's schema (docs/03 §3.3.10a): each key set becomes MANUAL,
  // null clears value and source both.
  fields?: Record<string, unknown>;
  reset?: DocumentResetEntry[];
};

// The shapes a person may file a document under (docs/05 §5.5 step 1), in the order they are
// offered: what the pipeline decided, then the two ways of overruling it.
export const PAGE_FORMATS = pageFormatSchema.options;

// What a scalar typed field holds while it is being edited (docs/03 §3.3.10a): each kind keeps the
// shape its input works in, and only Save turns it back into the stored value. A `table` has no
// draft because the form does not edit one (docs/11 §11.5).
export type FieldDraft =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number | null }
  | { kind: 'date'; value: string | null }
  | { kind: 'money'; amount: number | null; currency: string };

// What a person may correct, while they are correcting it. Held apart from the document so that
// nothing is sent until Save: a select that writes on every keystroke turns a glance into an edit.
export type Draft = {
  typeId: string | null;
  peopleIds: string[];
  subjectIds: string[];
  documentDate: string | null;
  languages: string[];
  country: string | null;
  city: string;
  pageFormat: PageFormat;
  fields: Record<string, FieldDraft>;
};

// A catalogue row is a living one by construction: `/api/people` and `/api/subjects` return only
// what has not been deleted (docs/07 §7.3).
export function living<T>(row: T): T & { deleted: boolean } {
  return { ...row, deleted: false };
}

export function isDeleted(
  options: ReadonlyArray<{ id: string; deleted: boolean }>,
  value: unknown,
): boolean {
  return options.some((option) => option.id === value && option.deleted);
}

// The catalogue first, then anything the document carries that the catalogue does not: a row is
// identified by its id, and the catalogue's copy wins when both have one, since it is the one a
// person can still choose.
export function mergeById<T extends { id: string }>(
  catalogue: readonly T[],
  onDocument: readonly T[],
): T[] {
  const seen = new Set(catalogue.map((entry) => entry.id));
  return [...catalogue, ...onDocument.filter((entry) => !seen.has(entry.id))];
}

// Which step writes which field (docs/05 §5.5): the page count comes with the preview, the text and
// the languages with the parse, the place and the documentType with the AI step. A field whose step
// has not settled is a field whose value is provisional, and it says so rather than showing an em
// dash that reads as "there is none".
//
// Module-level because two of the pane's three sections ask it (docs/11 §11.5), and the second of
// them is drawn apart from the form so that opening the form leaves it alone.
export function pendingState(
  document: DocumentDetailDto,
  steps: readonly DocumentStep[],
): 'PENDING' | 'RUNNING' | undefined {
  const statuses = steps.map((step) => document.steps[step]);
  if (statuses.includes('RUNNING')) return 'RUNNING';
  // A field is provisional whether a worker is on the way or nothing is scheduled at all; which of
  // those it is belongs to the step's own chip, not to every field the step writes.
  return statuses.includes('PENDING') || statuses.includes('QUEUED') ? 'PENDING' : undefined;
}

// The catalogues a read-only pane never asks for, as one frozen empty: a fresh `[]` per render
// would change identity every render and rebuild the memoized option lists under it for nothing
// (docs/11 §11.5e).
export const NO_CATALOGUE: never[] = [];

// The same choice made twice: two sets of links are equal when they hold the same ids, whatever
// order the control put them in — reordering a multi-select is not an edit.
export function sameIds(chosen: string[], current: string[]): boolean {
  if (chosen.length !== current.length) return false;
  const held = new Set(current);
  return chosen.every((id) => held.has(id));
}

// Something typed that is not already in the catalogue — the only case where offering to add a
// person is useful rather than noise.
export function isNewName(search: string, people: Array<{ name: string }>): boolean {
  const name = search.trim().toLowerCase();
  return name !== '' && !people.some((person) => person.name.toLowerCase() === name);
}

// A calendar day in the reader's own format. Rendered from the parts rather than by parsing into a
// Date: "2019-03-01" is a day, and a Date would make it a moment somewhere.
export function formatDate(date: string | null): string {
  if (date === null) return '';
  const [year, month, day] = date.split('-');
  if (year === undefined || month === undefined || day === undefined) return date;
  return new Intl.DateTimeFormat(navigator.language).format(
    new Date(Number(year), Number(month) - 1, Number(day)),
  );
}

// A stored typed value made a draft its input can hold (docs/03 §3.3.10a): a value the wrong shape
// for its kind is treated as no value, which is also what the server would have refused to store.
export function fieldDraftOf(spec: DocumentFieldSpec, raw: unknown): FieldDraft {
  switch (spec.kind) {
    case 'number':
      return {
        kind: 'number',
        value: typeof raw === 'number' && Number.isFinite(raw) ? raw : null,
      };
    case 'date':
      return {
        kind: 'date',
        value: typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null,
      };
    case 'money': {
      const money = moneyValueSchema.safeParse(raw);
      return money.success
        ? { kind: 'money', amount: money.data.amount, currency: money.data.currency }
        : { kind: 'money', amount: null, currency: '' };
    }
    default:
      return { kind: 'string', value: typeof raw === 'string' ? raw : '' };
  }
}

// What a draft sends on Save: the stored shape of its kind, null for an emptied input (= clear
// value and source both), or undefined for one that cannot travel yet — a money with only one of
// its halves is not a fact (docs/03 §3.3.10a).
export function patchValueOf(field: FieldDraft): unknown {
  if (field.kind === 'string') {
    const value = field.value.trim();
    return value === '' ? null : value;
  }
  if (field.kind === 'number') return field.value;
  if (field.kind === 'date') return field.value;
  const currency = field.currency.trim().toUpperCase();
  if (field.amount === null && currency === '') return null;
  if (field.amount === null || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return { amount: field.amount, currency };
}

// "Changed" for a typed field: nothing equals nothing, scalars compare as themselves, and a money
// compares by its two halves.
export function sameFieldValue(a: unknown, b: unknown): boolean {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty || bEmpty) return aEmpty && bEmpty;
  if (isRecord(a) && isRecord(b)) {
    const first = moneyValueSchema.safeParse(a);
    const second = moneyValueSchema.safeParse(b);
    return (
      first.success &&
      second.success &&
      first.data.amount === second.data.amount &&
      first.data.currency === second.data.currency
    );
  }
  return a === b;
}

// A typed value formatted for the reader (docs/11 §11.5): Intl dates and currency amounts, strings
// and numbers as they are. The empty string where the value is missing or misshapen, which the
// definition list prints as its em dash.
export function formatFieldValue(spec: DocumentFieldSpec, raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  switch (spec.kind) {
    case 'string':
      return typeof raw === 'string' ? raw : '';
    case 'number':
      return typeof raw === 'number' ? String(raw) : '';
    case 'date':
      return typeof raw === 'string' ? formatDate(raw) : '';
    case 'money': {
      const money = moneyValueSchema.safeParse(raw);
      if (!money.success) return '';
      try {
        return new Intl.NumberFormat(navigator.language, {
          style: 'currency',
          currency: money.data.currency,
        }).format(money.data.amount);
      } catch {
        return `${money.data.amount} ${money.data.currency}`;
      }
    }
    case 'table':
      return '';
  }
}

export function placeOf(city: string | null, country: string | null): string {
  return [city, displayCountry(country)].filter((part) => part !== null && part !== '').join(', ');
}

// The home screen, filtered — the address a filter already lives at (docs/11 §11.3). Used where no
// browse screen exists for the facet: a kind, and a place.
export function documentsHref(filters: Record<string, string>): string {
  return `/documents?${new URLSearchParams(filters).toString()}`;
}

// A place is one fact written in two boxes, and each box is a way in: the city inside its country,
// because "Bar" is a town in three of them, and the country on its own, because "everything from
// Montenegro" is a question people ask (docs/11 §11.5). Whichever half is missing is simply not
// printed, exactly as `placeOf` prints it.
export function placeWaysIn(
  city: string | null,
  country: string | null,
): Array<{ id: string; node: ReactNode }> {
  const ways: Array<{ id: string; node: ReactNode }> = [];
  if (city !== null && city !== '') {
    ways.push({
      id: 'city',
      node: (
        <Link href={documentsHref(country === null ? { city } : { country, city })}>{city}</Link>
      ),
    });
  }
  const countryName = displayCountry(country);
  if (country !== null && countryName !== null && countryName !== '') {
    ways.push({
      id: 'country',
      node: <Link href={documentsHref({ country })}>{countryName}</Link>,
    });
  }
  return ways;
}

// The year a `yyyy-mm-dd` carries, or null when there is no date: the four leading digits, never a
// Date, for the reason `formatDate` gives.
export function yearOf(date: string | null): string | null {
  if (date === null) return null;
  const year = date.slice(0, 4);
  return /^\d{4}$/.test(year) ? year : null;
}

// The kinds the analysis read, each once and in the order it read them — the "read as" line for the
// kind row, which shows the same de-duplicated set the row itself does.
export function distinctKinds(subjects: ReadonlyArray<{ kind: string }>): string {
  return [...new Set(subjects.map((subject) => subject.kind))].join(', ');
}

// Every language Intl can name, plus the tags already on the document that are not among them —
// `sr-Latn` is a real answer and no two-letter sweep will find it. Offered rather than left to be
// typed because a person adding Russian knows the word and not the code (docs/11 §11.5); the field
// still takes free tags for what neither list has.
export function languageOptions(
  current: string[],
  auto: string[],
): Array<{ value: string; label: string }> {
  const listed = new Set(LANGUAGE_OPTIONS.map((option) => option.value));
  const carried = [...new Set([...current, ...auto])]
    .filter((tag) => !listed.has(tag))
    .map((tag) => ({ value: tag, label: `${displayLanguage(tag)} (${tag})` }));
  return [...carried, ...LANGUAGE_OPTIONS];
}

// Every two-letter code Intl can put a name to, sorted by that name. Built by asking about all 676
// combinations and keeping the ones it answers: a list of countries or of languages is data that
// goes out of date, and one asked of Intl cannot.
function namedCodes(
  alphabet: string,
  describe: (code: string) => string,
  label: (code: string, name: string) => string,
): Array<{ value: string; label: string }> {
  const letters = alphabet.split('');
  const options: Array<{ value: string; label: string }> = [];
  for (const first of letters) {
    for (const second of letters) {
      const code = `${first}${second}`;
      const name = describe(code);
      // Intl answers an unknown code with the code itself, which is how a non-country is told from a
      // country without keeping a list of either.
      if (name !== code) options.push({ value: code, label: label(code, name) });
    }
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

// ISO 3166-1 alpha-2, named: "Montenegro", not "ME".
export const COUNTRY_OPTIONS: Array<{ value: string; label: string }> = namedCodes(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  (code) => displayCountry(code) ?? code,
  (_code, name) => name,
);

// ISO 639-1, named and with the tag in tow: "Russian (ru)". The tag is shown because it is what
// travels and what the pipeline reads, and a person correcting a language should be able to see the
// two agree.
const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = namedCodes(
  'abcdefghijklmnopqrstuvwxyz',
  displayLanguage,
  (code, name) => `${name} (${code})`,
);

// "ME" → "Montenegro", in the reader's own language. Intl knows the list; we do not keep one.
function displayCountry(code: string | null): string | null {
  if (code === null) return null;
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

// "ru" → "Russian" in the reader's own language, "sr-Latn" → "Serbian (Latin)". Intl does the work;
// no table of language names to keep up to date.
export function displayLanguage(tag: string): string {
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
