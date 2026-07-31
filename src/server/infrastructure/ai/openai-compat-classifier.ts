import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  DocumentClassifier,
  type CategoryOption,
} from '../../application/ports/document-classifier';
import { AppConfig } from '../config/app-config';

// Chat-completions, the shape every OpenAI-compatible runtime implements (docs/06 §6.3.3).
const completionResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

// The answer we ask for. Anything else — prose, a slug that was never offered — reads as "none".
const answerSchema = z.object({ slug: z.string() });

const SYSTEM_PROMPT = [
  'You classify documents into exactly one category from a fixed list.',
  'Answer with JSON only: {"slug": "<one of the listed slugs>"}.',
  'If no category fits the document, answer {"slug": "none"}.',
  'Never invent a slug that is not on the list.',
].join(' ');

// Deterministic answers: the same document must not land in a different category on a reprocess.
const TEMPERATURE = 0;

@Injectable()
export class OpenAiCompatClassifier extends DocumentClassifier {
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

  async classify(excerpt: string, categories: readonly CategoryOption[]): Promise<string | null> {
    if (!this.isConfigured) throw new Error('No document classifier is configured');
    if (categories.length === 0) return null;

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
      throw new Error(`Classifier request failed with ${response.status}: ${truncate(detail)}`);
    }

    const parsed = completionResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Classifier returned an unreadable response');

    return pickSlug(parsed.data.choices[0]?.message.content ?? '', categories);
  }
}

// The catalogue as the model sees it: slug, name, and the description an admin wrote as guidance
// (docs/03 §3.3.12).
function userPrompt(excerpt: string, categories: readonly CategoryOption[]): string {
  const list = categories
    .map((category) =>
      category.description === null || category.description === ''
        ? `- ${category.slug}: ${category.name}`
        : `- ${category.slug}: ${category.name} — ${category.description}`,
    )
    .join('\n');

  return `Categories:\n${list}\n\nDocument:\n"""\n${excerpt}\n"""`;
}

// 🔒 A model that answers with a category nobody defined must not create one: only a slug from the
// list we sent is accepted, anything else is "none" (docs/05 §5.5 step 4).
function pickSlug(content: string, categories: readonly CategoryOption[]): string | null {
  const parsed = answerSchema.safeParse(safeJson(extractJson(content)));
  if (!parsed.success) return null;

  const answer = parsed.data.slug.trim().toLowerCase();
  return categories.some((category) => category.slug === answer) ? answer : null;
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
