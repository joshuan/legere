import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  DocumentAnalyst,
  type DocumentTypeOption,
  type DocumentAnalysis,
} from '../../application/ports/document-analyst';
import { AppConfig } from '../config/app-config';

// Chat-completions, the shape every OpenAI-compatible runtime implements (docs/06 §6.3.3).
const completionResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

// The answer we ask for. Every field is optional and validated separately, so a model that gets the
// documentType right and the country wrong still contributes the documentType.
const answerSchema = z.object({
  slug: z.string().optional(),
  languages: z.array(z.string()).optional(),
  country: z.string().nullish(),
  city: z.string().nullish(),
  people: z.array(z.string()).optional(),
  date: z.string().nullish(),
});

const SYSTEM_PROMPT = [
  'You read a document and report four things as JSON, nothing else:',
  '{"slug": "<one of the listed slugs, or none>",',
  '"languages": ["<BCP-47 tags of the languages the document is written in>"],',
  '"country": "<ISO 3166-1 alpha-2 code of the country the document belongs to, or null>",',
  '"city": "<the city the document belongs to, as written, or null>",',
  '"people": ["<the people this document is about, as it names them>"],',
  '"date": "<the date written on the document, yyyy-mm-dd, or null>"}.',
  'Never invent a slug that is not on the list.',
  'Infer the country and the city from what the document is about — an issuing office, an operator,',
  'a station, a currency, an address, a phone prefix — not only from words naming a country.',
  'When several places appear, name the one the document comes from — the issuer, or the point of',
  'departure — never a destination.',
  'If you name a city, name the country that city is in as well.',
  'Use null when the document gives you no reason to name one; a guess is worse than nothing.',
  'People are the parties, the holder, the passenger, the patient — not the clerk who stamped it,',
  'not the company. Give each name once, as written. Empty list if the document names nobody.',
  'The date is the one the document is *about* — signed, issued, valid from, departing — not the day',
  'it was printed or scanned. When several appear, take the one that dates the document itself.',
].join(' ');

// Deterministic answers: the same document must not land in a different documentType on a reprocess.
const TEMPERATURE = 0;

// "ru", "sr-Latn", "pt-BR" — a language subtag, optionally a script, optionally a region. Anything
// else the model invents ("russian", "cyrillic") is dropped rather than stored.
const BCP47 = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/;
const MAX_LANGUAGES = 4;
const MAX_CITY_CHARS = 100;
// A document names a few people; a model that answers with forty has misread a page of text as a
// guest list, and the catalogue should not grow by forty rows because of it.
const MAX_PEOPLE = 8;
const MAX_NAME_CHARS = 200;

@Injectable()
export class OpenAiCompatAnalyst extends DocumentAnalyst {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: AppConfig) {
    super();
    // An empty CLASSIFIER_API_BASE_URL reuses the embeddings endpoint, since one local runtime
    // usually serves both (docs/12 §12.4).
    const base =
      config.get('CLASSIFIER_API_BASE_URL') === ''
        ? config.get('EMBEDDINGS_API_BASE_URL')
        : config.get('CLASSIFIER_API_BASE_URL');
    this.baseUrl = base.replace(/\/+$/, '');
    this.apiKey =
      config.get('CLASSIFIER_API_KEY') === ''
        ? config.get('EMBEDDINGS_API_KEY')
        : config.get('CLASSIFIER_API_KEY');
    this.model = config.get('CLASSIFIER_MODEL');
  }

  // A base URL alone is not enough: without a model name there is nothing to ask.
  get isConfigured(): boolean {
    return this.baseUrl !== '' && this.model !== '';
  }

  async analyze(
    excerpt: string,
    documentTypes: readonly DocumentTypeOption[],
  ): Promise<DocumentAnalysis> {
    if (!this.isConfigured) throw new Error('No document analyst is configured');

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey === '' ? {} : { authorization: `Bearer ${this.apiKey}` }),
      },
      body: JSON.stringify({
        model: this.model,
        temperature: TEMPERATURE,
        // Asking for a JSON object is a hint, not a guarantee — the answer is validated below either
        // way, and providers that do not support the flag ignore it.
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt(excerpt, documentTypes) },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Analyst request failed with ${response.status}: ${truncate(detail)}`);
    }

    const parsed = completionResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Analyst returned an unreadable response');

    return readAnswer(parsed.data.choices[0]?.message.content ?? '', documentTypes);
  }
}

// The catalogue as the model sees it: slug, name, and the description an admin wrote as guidance
// (docs/03 §3.3.12). With no documentTypes defined there is still a place to read — the list is simply
// empty and "none" is the only honest slug.
function userPrompt(excerpt: string, documentTypes: readonly DocumentTypeOption[]): string {
  const list =
    documentTypes.length === 0
      ? '(none defined — answer "none")'
      : documentTypes
          .map((documentType) =>
            documentType.description === null || documentType.description === ''
              ? `- ${documentType.slug}: ${documentType.name}`
              : `- ${documentType.slug}: ${documentType.name} — ${documentType.description}`,
          )
          .join('\n');

  return `DocumentTypes:\n${list}\n\nDocument:\n"""\n${excerpt}\n"""`;
}

function readAnswer(
  content: string,
  documentTypes: readonly DocumentTypeOption[],
): DocumentAnalysis {
  const parsed = answerSchema.safeParse(safeJson(extractJson(content)));
  if (!parsed.success) {
    return { typeSlug: null, languages: [], country: null, city: null, people: [], date: null };
  }

  return {
    typeSlug: pickSlug(parsed.data.slug ?? '', documentTypes),
    languages: pickLanguages(parsed.data.languages ?? []),
    country: pickCountry(parsed.data.country),
    city: pickCity(parsed.data.city),
    people: pickPeople(parsed.data.people ?? []),
    date: pickDate(parsed.data.date),
  };
}

// 🔒 A model that answers with a documentType nobody defined must not create one: only a slug from the
// list we sent is accepted, anything else is "none" (docs/05 §5.5 step 4).
function pickSlug(slug: string, documentTypes: readonly DocumentTypeOption[]): string | null {
  const answer = slug.trim().toLowerCase();
  return documentTypes.some((documentType) => documentType.slug === answer) ? answer : null;
}

function pickLanguages(languages: string[]): string[] {
  const tags = languages.map((tag) => tag.trim()).filter((tag) => BCP47.test(tag));
  return [...new Set(tags)].slice(0, MAX_LANGUAGES);
}

// Upper-cased because ISO 3166-1 alpha-2 is written that way, and a stored "me" would never match a
// lookup for "ME". "XX", "N/A" and prose are dropped by the shape check.
function pickCountry(country: string | null | undefined): string | null {
  const code = (country ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function pickCity(city: string | null | undefined): string | null {
  const name = (city ?? '').trim();
  if (name === '' || name.length > MAX_CITY_CHARS) return null;
  // Models answer "unknown" instead of null often enough to be worth catching.
  return /^(unknown|n\/?a|none|null)$/i.test(name) ? null : name;
}

// Trimmed, deduplicated case-insensitively, and capped. Names are free text — there is no shape to
// validate — so the only defences are length and count.
function pickPeople(people: string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of people) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (name === '' || name.length > MAX_NAME_CHARS) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length === MAX_PEOPLE) break;
  }
  return names;
}

// A calendar date in a plausible century, or nothing. Models answer "2026-13-45", "n/a" and
// "25.07.2026" with equal confidence; only the first form, and only if it is a real day, is kept.
function pickDate(date: string | null | undefined): string | null {
  const value = (date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  const year = parsed.getUTCFullYear();
  return year >= 1900 && year <= 2100 ? value : null;
}

// Models like to wrap JSON in prose or a ```json fence; take the first object in the answer.
function extractJson(content: string): string {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  return start === -1 || end <= start ? content : content.slice(start, end + 1);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
