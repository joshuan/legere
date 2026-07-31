import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { loadConfig } from '../config/app-config';
import { OpenAiCompatEmbeddings } from './openai-compat-embeddings';

type FetchSpy = MockInstance<typeof fetch>;

function provider(overrides: Record<string, string> = {}): OpenAiCompatEmbeddings {
  return new OpenAiCompatEmbeddings(
    loadConfig({
      DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
      APP_BASE_URL: 'http://localhost:3000',
      AUTH_SECRET: 'test-secret-minimum-32-characters!!',
      EMBEDDINGS_API_BASE_URL: 'https://api.example.com/v1',
      EMBEDDINGS_API_KEY: 'secret-key',
      EMBEDDINGS_MODEL: 'text-embedding-3-small',
      EMBEDDING_DIMENSIONS: '3',
      ...overrides,
    }),
  );
}

const vector = (start: number): number[] => [start, start + 0.5, start + 1];

function requestOf(spy: FetchSpy): { url: string; body: unknown; headers: Headers } {
  const [url, init] = spy.mock.calls[0] ?? [];
  if (typeof url !== 'string') throw new Error('expected a string URL');
  const body = init instanceof Object && 'body' in init ? init.body : undefined;
  if (typeof body !== 'string') throw new Error('expected a JSON body');
  return { url, body: JSON.parse(body), headers: new Headers(init?.headers) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAiCompatEmbeddings', () => {
  it('is unconfigured without a base URL, which is how an instance runs with no AI', () => {
    expect(provider({ EMBEDDINGS_API_BASE_URL: '' }).isConfigured).toBe(false);
    expect(provider().isConfigured).toBe(true);
  });

  it('posts the texts to the embeddings endpoint with the model and the key', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ data: [{ index: 0, embedding: vector(0) }] }));

    await provider().embed(['one chunk']);

    const request = requestOf(spy);
    expect(request.url).toBe('https://api.example.com/v1/embeddings');
    expect(request.headers.get('authorization')).toBe('Bearer secret-key');
    expect(request.body).toEqual({ model: 'text-embedding-3-small', input: ['one chunk'] });
  });

  it('sends no authorization header when the provider needs no key', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ data: [{ index: 0, embedding: vector(0) }] }));

    // A local runtime (Ollama, LM Studio) usually has no key at all.
    await provider({ EMBEDDINGS_API_KEY: '' }).embed(['x']);

    expect(requestOf(spy).headers.get('authorization')).toBeNull();
  });

  it('returns the vectors in the order of the texts, not of the response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        data: [
          { index: 1, embedding: vector(10) },
          { index: 0, embedding: vector(0) },
        ],
      }),
    );

    // The API is allowed to answer out of order; chunk 0 must still get vector 0.
    expect(await provider().embed(['first', 'second'])).toEqual([vector(0), vector(10)]);
  });

  it('asks for nothing when there is nothing to embed', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');

    expect(await provider().embed([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a batch whose vectors do not fit the column', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] }),
    );

    // 🔒 vector(1536) is fixed by the schema: half-written chunks would be worse than none.
    await expect(provider().embed(['x'])).rejects.toThrow(/4 dimensions, expected 3/);
  });

  it('fails when the provider skips one of the texts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ data: [{ index: 0, embedding: vector(0) }] }),
    );

    await expect(provider().embed(['first', 'second'])).rejects.toThrow(/skipped text 1/);
  });

  it('reports an HTTP failure with what the provider said', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"model not found"}', { status: 404 }),
    );

    await expect(provider().embed(['x'])).rejects.toThrow(/404.*model not found/s);
  });

  it('refuses to pretend when nothing is configured', async () => {
    await expect(provider({ EMBEDDINGS_API_BASE_URL: '' }).embed(['x'])).rejects.toThrow(
      /No embeddings provider/,
    );
  });
});
