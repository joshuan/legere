import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { CategoryOption } from '../../application/ports/document-classifier';
import { loadConfig } from '../config/app-config';
import { OpenAiCompatClassifier } from './openai-compat-classifier';

type FetchSpy = MockInstance<typeof fetch>;

const CATEGORIES: CategoryOption[] = [
  { slug: 'invoice', name: 'Invoice', description: 'Bills and payment requests.' },
  { slug: 'contract', name: 'Contract', description: null },
];

function classifier(overrides: Record<string, string> = {}): OpenAiCompatClassifier {
  return new OpenAiCompatClassifier(
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

describe('OpenAiCompatClassifier', () => {
  describe('configuration', () => {
    it('needs both an endpoint and a model', () => {
      expect(classifier().isConfigured).toBe(true);
      expect(classifier({ CLASSIFIER_MODEL: '' }).isConfigured).toBe(false);
      expect(
        classifier({ CLASSIFIER_API_BASE_URL: '', EMBEDDINGS_API_BASE_URL: '' }).isConfigured,
      ).toBe(false);
    });

    it('falls back to the embeddings endpoint, since one runtime usually serves both', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('{"slug":"invoice"}'));

      await classifier({ CLASSIFIER_API_BASE_URL: '', CLASSIFIER_API_KEY: '' }).classify(
        'text',
        CATEGORIES,
      );

      expect(requestOf(spy).url).toBe('https://embeddings.example.com/v1/chat/completions');
    });
  });

  describe('the prompt', () => {
    it('offers every slug with the description an admin wrote', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('{"slug":"invoice"}'));

      await classifier().classify('Amount due: 1200', CATEGORIES);

      const { url, body } = requestOf(spy);
      expect(url).toBe('https://llm.example.com/v1/chat/completions');
      expect(body.model).toBe('gpt-4o-mini');
      // Deterministic, so a reprocess does not silently move a document to another category.
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

      expect(await classifier().classify('text', CATEGORIES)).toBe('contract');
    });

    it('reads JSON out of a fenced or chatty answer', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        answers('Sure!\n```json\n{"slug": "invoice"}\n```'),
      );

      expect(await classifier().classify('text', CATEGORIES)).toBe('invoice');
    });

    it('refuses a slug that was never offered', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('{"slug":"tax-return"}'));

      // 🔒 The model does not get to invent categories (docs/05 §5.5 step 4).
      expect(await classifier().classify('text', CATEGORIES)).toBeNull();
    });

    it('reads an explicit "none" as no category', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('{"slug":"none"}'));

      expect(await classifier().classify('text', CATEGORIES)).toBeNull();
    });

    it('treats prose with no JSON in it as no category', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        answers('I think this document is an invoice.'),
      );

      expect(await classifier().classify('text', CATEGORIES)).toBeNull();
    });

    it('ignores case and stray spacing in the slug', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('{"slug":" Invoice "}'));

      expect(await classifier().classify('text', CATEGORIES)).toBe('invoice');
    });

    it('answers nothing when there are no categories to choose from', async () => {
      const spy = vi.spyOn(globalThis, 'fetch');

      expect(await classifier().classify('text', [])).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('reports an HTTP failure with what the provider said', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('rate limited, retry later', { status: 429 }),
    );

    await expect(classifier().classify('text', CATEGORIES)).rejects.toThrow(/429.*rate limited/s);
  });

  it('refuses to pretend when nothing is configured', async () => {
    await expect(classifier({ CLASSIFIER_MODEL: '' }).classify('text', CATEGORIES)).rejects.toThrow(
      /No document classifier/,
    );
  });
});
