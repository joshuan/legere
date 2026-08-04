import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { DocumentTypeOption } from '../../application/ports/document-analyst';
import { loadConfig } from '../config/app-config';
import { OpenAiCompatAnalyst } from './openai-compat-analyst';

type FetchSpy = MockInstance<typeof fetch>;

const CATEGORIES: DocumentTypeOption[] = [
  { slug: 'invoice', name: 'Invoice', description: 'Bills and payment requests.' },
  { slug: 'contract', name: 'Contract', description: null },
];

function analyst(overrides: Record<string, string> = {}): OpenAiCompatAnalyst {
  return new OpenAiCompatAnalyst(
    loadConfig({
      DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
      APP_BASE_URL: 'http://localhost:3000',
      AUTH_SECRET: 'test-secret-minimum-32-characters!!',
      EMBEDDINGS_API_BASE_URL: 'https://embeddings.example.com/v1',
      EMBEDDINGS_API_KEY: 'shared-key',
      CLASSIFIER_API_BASE_URL: 'https://llm.example.com/v1',
      CLASSIFIER_API_KEY: 'llm-key',
      CLASSIFIER_MODEL: 'gpt-4o-mini',
      ...overrides,
    }),
  );
}

function answers(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

function requestOf(spy: FetchSpy): { url: string; body: Record<string, unknown> } {
  const [url, init] = spy.mock.calls[0] ?? [];
  if (typeof url !== 'string') throw new Error('expected a string URL');
  const body = init instanceof Object && 'body' in init ? init.body : undefined;
  if (typeof body !== 'string') throw new Error('expected a JSON body');
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('expected an object body');
  return { url, body: { ...parsed } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAiCompatAnalyst', () => {
  describe('configuration', () => {
    it('needs both an endpoint and a model', () => {
      expect(analyst().isConfigured).toBe(true);
      expect(analyst({ CLASSIFIER_MODEL: '' }).isConfigured).toBe(false);
      expect(
        analyst({ CLASSIFIER_API_BASE_URL: '', EMBEDDINGS_API_BASE_URL: '' }).isConfigured,
      ).toBe(false);
    });

    it('falls back to the embeddings endpoint, since one runtime usually serves both', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('{"slug":"invoice"}'));

      await analyst({ CLASSIFIER_API_BASE_URL: '', CLASSIFIER_API_KEY: '' }).analyze(
        'text',
        CATEGORIES,
      );

      expect(requestOf(spy).url).toBe('https://embeddings.example.com/v1/chat/completions');
    });
  });

  describe('the prompt', () => {
    it('offers every slug with the description an admin wrote', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('{"slug":"invoice"}'));

      await analyst().analyze('Amount due: 1200', CATEGORIES);

      const { url, body } = requestOf(spy);
      expect(url).toBe('https://llm.example.com/v1/chat/completions');
      expect(body.model).toBe('gpt-4o-mini');
      // Deterministic, so a reprocess does not silently move a document to another documentType.
      expect(body.temperature).toBe(0);

      const messages = body.messages;
      const prompt = JSON.stringify(messages);
      expect(prompt).toContain('invoice: Invoice — Bills and payment requests.');
      expect(prompt).toContain('contract: Contract');
      expect(prompt).toContain('Amount due: 1200');
    });
  });

  describe('the answer', () => {
    it('accepts a slug from the list', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('{"slug":"contract"}'));

      expect((await analyst().analyze('text', CATEGORIES)).typeSlug).toBe('contract');
    });

    it('reads JSON out of a fenced or chatty answer', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        answers('Sure!\n```json\n{"slug": "invoice"}\n```'),
      );

      expect((await analyst().analyze('text', CATEGORIES)).typeSlug).toBe('invoice');
    });

    it('refuses a slug that was never offered', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('{"slug":"tax-return"}'));

      // 🔒 The model does not get to invent documentTypes (docs/05 §5.5 step 4).
      expect((await analyst().analyze('text', CATEGORIES)).typeSlug).toBeNull();
    });

    it('reads an explicit "none" as no documentType', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('{"slug":"none"}'));

      expect((await analyst().analyze('text', CATEGORIES)).typeSlug).toBeNull();
    });

    it('treats prose with no JSON in it as no documentType', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        answers('I think this document is an invoice.'),
      );

      expect((await analyst().analyze('text', CATEGORIES)).typeSlug).toBeNull();
    });

    it('ignores case and stray spacing in the slug', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('{"slug":" Invoice "}'));

      expect((await analyst().analyze('text', CATEGORIES)).typeSlug).toBe('invoice');
    });

    it('still asks when no documentTypes are defined — the place is worth the call', async () => {
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(answers('{"slug":"none","country":"ME"}'));

      const result = await analyst().analyze('ŽPCG Podgorica', []);

      expect(result).toEqual({
        title: null,
        typeSlug: null,
        languages: [],
        country: 'ME',
        city: null,
        people: [],
        date: null,
        subjects: [],
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('takes the place from an answer that got the documentType wrong', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        answers(
          '{"slug":"tax-return","languages":["sr-Latn","en"],"country":"me","city":"Podgorica"}',
        ),
      );

      // Each field stands or falls on its own: an invented slug does not discard a good country.
      expect(await analyst().analyze('text', CATEGORIES)).toEqual({
        title: null,
        typeSlug: null,
        people: [],
        date: null,
        subjects: [],
        languages: ['sr-Latn', 'en'],
        // 🔒 Upper-cased: a stored 'me' would never match a lookup for 'ME'.
        country: 'ME',
        city: 'Podgorica',
      });
    });

    it('reads the people a document is about, once each and trimmed', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        answers('{"people":["  Evgenii   Shershnev ","EVGENII SHERSHNEV","Marija Petrović",""]}'),
      );

      const result = await analyst().analyze('text', CATEGORIES);

      // The same person written twice is one name: the catalogue must not gain a row because a
      // model changed its capitalisation (docs/03 §3.3.19).
      expect(result.people).toEqual(['Evgenii Shershnev', 'Marija Petrović']);
    });

    it('keeps a date only when it is a calendar day in a plausible century', async () => {
      for (const [answered, expected] of [
        ['2026-07-25', '2026-07-25'],
        // A day that does not exist, a format nobody asked for, a year nobody files.
        ['2026-02-31', null],
        ['25.07.2026', null],
        ['1723-01-01', null],
        ['unknown', null],
      ] as const) {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers(`{"date":"${answered}"}`));
        expect((await analyst().analyze('text', CATEGORIES)).date).toBe(expected);
        vi.restoreAllMocks();
      }
    });

    it('takes a title as one trimmed line, and refuses a paragraph pretending to be one', async () => {
      for (const [answered, expected] of [
        ['Rental agreement, Njegoševa 12', 'Rental agreement, Njegoševa 12'],
        // A model that wrapped its line still gave a good title.
        ['Rental agreement,\\n  Njegoševa 12', 'Rental agreement, Njegoševa 12'],
        ['\\"Rental agreement\\"', 'Rental agreement'],
        // Asked for a title, answered with the document.
        [`${'text '.repeat(60)}`, null],
        ['untitled', null],
        ['', null],
      ] as const) {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers(`{"title":"${answered}"}`));
        expect((await analyst().analyze('text', CATEGORIES)).title).toBe(expected);
        vi.restoreAllMocks();
      }
    });

    it('drops language tags that are not tags and places that are not places', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        answers('{"languages":["russian","ru","ru"],"country":"Montenegro","city":"unknown"}'),
      );

      const result = await analyst().analyze('text', CATEGORIES);

      // "russian" is not BCP-47 and "Montenegro" is not alpha-2; a duplicate tag is stored once.
      expect(result.languages).toEqual(['ru']);
      expect(result.country).toBeNull();
      // Models say "unknown" where the prompt asked for null.
      expect(result.city).toBeNull();
    });
  });

  it('reports an HTTP failure with what the provider said', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('rate limited, retry later', { status: 429 }),
    );

    await expect(analyst().analyze('text', CATEGORIES)).rejects.toThrow(/429.*rate limited/s);
  });

  it('refuses to pretend when nothing is configured', async () => {
    await expect(analyst({ CLASSIFIER_MODEL: '' }).analyze('text', CATEGORIES)).rejects.toThrow(
      /No document analyst/,
    );
  });
});
