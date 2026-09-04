import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { readBoundedJson, readBoundedText } from '../../application/ports/binary-source';
import type { PageImage } from '../../application/ports/document-analyst';
import { PageTranscriber, type Transcription } from '../../application/ports/page-transcriber';
import {
  ServiceUnavailableError,
  isUnavailableStatus,
  reachService,
  throttledOrUnavailable,
} from '../../application/ports/service-unavailable';
import { ServiceGates } from '../../application/queue/service-gate';
import { AppConfig } from '../config/app-config';
import { serviceEndpoint } from '../config/service-endpoints';
import { callHeaders } from '../logging/async-call-context';
import { describeLanguage } from './language-names';

// The recogniser of last resort, over the same OpenAI-compatible surface everything else here speaks
// (docs/05 §5.5 step 3). One call for the whole document: a table split across two requests comes
// back as two tables, and the pages of one paper are one piece of reading.

// 🔒 A page is read, not printed: the model gets a legible image and nothing more. The cap on how
// long the answer may be is the document's own text, which for twenty pages of dense typing is a few
// hundred kilobytes — 8 MiB refuses a runtime that answers with a stream instead.
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

// 🔒 Longer than the analyst's five minutes, and deliberately: this is the one call that reads every
// page of a document rather than judging an excerpt of it, and a twenty-page transcription on a slow
// runtime is minutes of honest work. Still bounded, because a hung endpoint would otherwise hold a
// `document-process` worker until undici's 300 s and a drip defeats even that (docs/05 §5.4).
const TIMEOUT_MS = 20 * 60_000;

// Deterministic transcription: this is reading, not writing. A model asked to be creative about what
// a lab report says is a model inventing results.
const TEMPERATURE = 0;

const completionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        // Why the model stopped. `length` means the page was cut off mid-sentence, which looks
        // exactly like a finished transcription from the outside.
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

@Injectable()
export class OpenAiCompatTranscriber extends PageTranscriber {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(
    config: AppConfig,
    private readonly gates: ServiceGates,
  ) {
    super();
    // Resolved where the probe of docs/05 §5.4c reads it from too, so the address the panel shows is
    // the address this client calls (`service-endpoints.ts`).
    const endpoint = serviceEndpoint(config, 'transcriber');
    this.baseUrl = endpoint.baseUrl;
    this.apiKey = endpoint.apiKey;
    this.model = config.get('TRANSCRIBER_MODEL');
  }

  // A base URL alone is not enough: without a model name there is nothing to ask.
  get isConfigured(): boolean {
    return this.baseUrl !== '' && this.model !== '';
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  async transcribe(
    pages: readonly PageImage[],
    languages: readonly string[],
  ): Promise<Transcription> {
    if (!this.isConfigured) throw new Error('No page transcriber is configured');
    if (pages.length === 0) return { markdown: '', usage: {} };

    // One transcription — the whole document in one call — is one unit of the `transcriber` gate
    // (docs/05 §5.4b). Classified like every service exchange (docs/05 §5.4e); the step that calls
    // this is best-effort and falls back to the recognised text either way.
    return this.gates.run('transcriber', () =>
      reachService('transcriber', () => this.read(pages, languages)),
    );
  }

  private async read(
    pages: readonly PageImage[],
    languages: readonly string[],
  ): Promise<Transcription> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey === '' ? {} : { authorization: `Bearer ${this.apiKey}` }),
        ...callHeaders(),
      },
      body: JSON.stringify({
        model: this.model,
        temperature: TEMPERATURE,
        messages: [
          { role: 'system', content: systemMessage(languages) },
          {
            role: 'user',
            content: pages.map((page) => ({
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${page.bytes.toString('base64')}` },
            })),
          },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.status === 429) {
      throw throttledOrUnavailable('transcriber', response.headers.get('retry-after'));
    }
    if (isUnavailableStatus(response.status)) {
      // A proxy answering for a provider that is not there (docs/05 §5.4e).
      throw new ServiceUnavailableError(
        'transcriber',
        `/chat/completions answered ${response.status}`,
      );
    }
    if (!response.ok) {
      const detail = await readBoundedText(response, MAX_ERROR_BYTES).catch(() => '');
      throw new Error(
        `Transcriber request failed with ${response.status}: ${detail.slice(0, 500)}`,
      );
    }

    const parsed = completionResponseSchema.safeParse(
      await readBoundedJson(response, MAX_ANSWER_BYTES),
    );
    if (!parsed.success) throw new Error('Transcriber returned an unreadable response');

    const choice = parsed.data.choices[0];
    // 🔒 A transcription that ran out of room is half a document that reads as a whole one. Measured
    // in trials: `finish_reason` is the only thing that tells the two apart — the status is 200 and
    // the text ends on a plausible line. Refused here so the caller keeps what OCR already had.
    if (choice?.finish_reason === 'length') {
      throw new Error('Transcriber ran out of output before the document ended');
    }

    return {
      markdown: sanitise(stripCodeFence(choice?.message.content ?? '')).trim(),
      usage: {
        ...(parsed.data.usage?.prompt_tokens === undefined
          ? {}
          : { promptTokens: parsed.data.usage.prompt_tokens }),
        ...(parsed.data.usage?.completion_tokens === undefined
          ? {}
          : { completionTokens: parsed.data.usage.completion_tokens }),
      },
    };
  }
}

// 🔒 Every sentence here exists because of a way this goes wrong. A model asked to "read a document"
// summarises it; asked for Markdown it wraps the answer in a fence; shown a stamp it describes the
// stamp instead of transcribing it; and asked to be helpful about an illegible word it invents a
// plausible one — which in a lab report is a made-up test result. A missing value is a gap somebody
// can see; a wrong one is a lie the archive will repeat for years.
function systemMessage(languages: readonly string[]): string {
  const named = languages
    .map((language) => describeLanguage(language))
    .filter((name) => name !== '')
    .join(', ');

  return [
    'You transcribe photographed and scanned documents. The images that follow are the pages of one',
    'document, in order.',
    'Write out everything that is written on them, as Markdown, and nothing else.',
    'Keep the structure of the page: headings as headings, tables as Markdown tables with the same',
    'rows and columns, lists as lists. A table is the part most worth getting right — transcribe',
    'every row, including the ones whose cells are empty, and keep the empty cells empty.',
    'Transcribe stamps, letterheads, handwriting and signatures as the text they carry, marking a',
    'signature as [signature] when it is a mark rather than a name.',
    '🔒 Never invent, correct, complete or translate anything. Write what is on the page in the',
    'language it is written in, character for character, including numbers, units and codes.',
    'Where a word or a value is genuinely illegible, write [?] in its place — a gap somebody can see',
    'is worth far more than a plausible guess, and a guessed value in a document like this is a lie',
    'that will be believed. Guessing is the failure, not the gap.',
    'Do not merge, split, drop or reorder rows, and never move a value into a neighbouring row: a',
    'result that ends up beside the wrong test is worse than a result nobody transcribed.',
    'Never write Markdown image syntax, and never write a file path or a URL that is not printed on',
    'the page.',
    'Do not summarise, do not comment, do not describe the images, and do not add a preamble or a',
    'closing remark. Do not wrap the answer in a code fence.',
    named === '' ? '' : `The document is written in ${named}.`,
  ]
    .filter((line) => line !== '')
    .join(' ');
}

// 🔒 Measured, not imagined: in trials this model emitted `![ЛОТОС](file:///var/folders/…/tmp.jpg)`
// in four runs of seven — a Markdown image pointing at a temporary file on the *provider's* disk.
// The prompt forbids it in as many words and it happens anyway, which is the whole reason this
// function exists rather than another sentence in the instructions. Two things are wrong with it:
// the document gains a picture that is not on the page, and the archive gains somebody else's
// filesystem path in the middle of a lab report.
//
// The line is dropped rather than the link unwrapped: a hallucinated image has no alt text worth
// keeping, and a page that genuinely contains a picture has that picture in the canonical PDF, where
// the reader looks at it.
function sanitise(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !/!\[[^\]]*\]\([^)]*\)/u.test(line))
    .join('\n');
}

// Models wrap Markdown in a fence about half the time, whatever they are told. Unwrapping it here is
// cheaper than arguing with the prompt, and harmless when there is none.
function stripCodeFence(content: string): string {
  const fenced = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n?```\s*$/u.exec(content);
  return fenced?.[1] ?? content;
}
