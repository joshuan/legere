import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  DocumentAnalyst,
  type CategoryOption,
  type DocumentAnalysis,
} from '../../application/ports/document-analyst';
import { AppConfig } from '../config/app-config';

// Chat-completions, the shape every OpenAI-compatible runtime implements (docs/06 §6.3.3).
const completionResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

// The answer we ask for. Every field is optional and validated separately, so a model that gets the
// category right and the country wrong still contributes the category.
const answerSchema = z.object({
  slug: z.string().optional(),
  languages: z.array(z.string()).optional(),
  country: z.string().nullish(),
  city: z.string().nullish(),
});

const SYSTEM_PROMPT = [
  'You read a document and report four things as JSON, nothing else:',
  '{"slug": "<one of the listed slugs, or none>",',
  '"languages": ["<BCP-47 tags of the languages the document is written in>"],',
  '"country": "<ISO 3166-1 alpha-2 code of the country the document belongs to, or null>",',
  '"city": "<the city the document belongs to, as written, or null>"}.',
  'Never invent a slug that is not on the list.',
  'Infer the country and the city from what the document is about — an issuing office, an operator,',
  'a station, a currency, an address, a phone prefix — not only from words naming a country.',
  'Use null when the document gives you no reason to name one; a guess is worse than nothing.',
].join(' ');

// Deterministic answers: the same document must not land in a different category on a reprocess.
const TEMPERATURE = 0;

// "ru", "sr-Latn", "pt-BR" — a language subtag, optionally a script, optionally a region. Anything
// else the model invents ("russian", "cyrillic") is dropped rather than stored.
const BCP47 = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/;
const MAX_LANGUAGES = 4;
const MAX_CITY_CHARS = 100;

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

  async analyze(excerpt: string, categories: readonly CategoryOption[]): Promise<DocumentAnalysis> {
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
          { role: 'user', content: userPrompt(excerpt, categories) },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Analyst request failed with ${response.status}: ${truncate(detail)}`);
    }

    const parsed = completionResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Analyst returned an unreadable response');

    return readAnswer(parsed.data.choices[0]?.message.content ?? '', categories);
  }
}

// The catalogue as the model sees it: slug, name, and the description an admin wrote as guidance
// (docs/03 §3.3.12). With no categories defined there is still a place to read — the list is simply
// empty and "none" is the only honest slug.
function userPrompt(excerpt: string, categories: readonly CategoryOption[]): string {
  const list =
    categories.length === 0
      ? '(none defined — answer "none")'
      : categories
          .map((category) =>
            category.description === null || category.description === ''
              ? `- ${category.slug}: ${category.name}`
              : `- ${category.slug}: ${category.name} — ${category.description}`,
          )
          .join('\n');

  return `Categories:\n${list}\n\nDocument:\n"""\n${excerpt}\n"""`;
}

function readAnswer(content: string, categories: readonly CategoryOption[]): DocumentAnalysis {
  const parsed = answerSchema.safeParse(safeJson(extractJson(content)));
  if (!parsed.success) return { categorySlug: null, languages: [], country: null, city: null };

  return {
    categorySlug: pickSlug(parsed.data.slug ?? '', categories),
    languages: pickLanguages(parsed.data.languages ?? []),
    country: pickCountry(parsed.data.country),
    city: pickCity(parsed.data.city),
  };
}

// 🔒 A model that answers with a category nobody defined must not create one: only a slug from the
// list we sent is accepted, anything else is "none" (docs/05 §5.5 step 4).
function pickSlug(slug: string, categories: readonly CategoryOption[]): string | null {
  const answer = slug.trim().toLowerCase();
  return categories.some((category) => category.slug === answer) ? answer : null;
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
