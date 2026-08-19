import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { endlessBody, neverAnswers, stubTimeouts } from '../../../../test/helpers/outbound';
import { ServiceUnavailableError } from '../../application/ports/service-unavailable';
import { ServiceGates } from '../../application/queue/service-gate';
import { FixedClock } from '../../../../test/helpers/fakes';
import { loadConfig } from '../config/app-config';
import { OpenAiCompatEmbeddings } from './openai-compat-embeddings';

type FetchSpy = MockInstance<typeof fetch>;

function provider(
  overrides: Record<string, string> = {},
  gates: ServiceGates = new ServiceGates(new FixedClock()),
): OpenAiCompatEmbeddings {
  return new OpenAiCompatEmbeddings(
    loadConfig({
      DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
      APP_BASE_URL: 'http://localhost:3000',
      AUTH_SECRET: 'test-secret-minimum-32-characters!!',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
      EMBEDDINGS_API_BASE_URL: 'https://api.example.com/v1',
      EMBEDDINGS_API_KEY: 'secret-key',
      EMBEDDINGS_MODEL: 'text-embedding-3-small',
      EMBEDDING_DIMENSIONS: '3',
      ...overrides,
    }),
    gates,
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

    // 🔒 The column's width is fixed by the schema: half-written chunks would be worse than none.
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

  it('classifies a 503 as the provider being away, not this document failing (docs/05 §5.4e)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 }),
    );

    await expect(provider().embed(['x'])).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('refuses to pretend when nothing is configured', async () => {
    await expect(provider({ EMBEDDINGS_API_BASE_URL: '' }).embed(['x'])).rejects.toThrow(
      /No embeddings provider/,
    );
  });
});

// 🔒 SEC-17. The provider is whatever the operator pointed this at, and a vectorization worker that
// waits on it for ever is a worker the queue never gets back (docs/05 §5.4).
describe('OpenAiCompatEmbeddings (a provider that misbehaves)', () => {
  it('gives up on a provider that accepts the batch and then never answers', async () => {
    const timeouts = stubTimeouts();
    neverAnswers();

    const call = provider().embed(['one chunk']);
    // What the clock would have done two minutes later. Without the signal there is nothing to fire
    // and nothing to fail: this call would sit here until the test itself timed out.
    timeouts.expire();

    await expect(call).rejects.toThrow(/timed out/i);
    expect(timeouts.requested()).toEqual([2 * 60_000]);
  });

  it('refuses an answer that never stops arriving instead of reading it whole', async () => {
    const { response, produced } = endlessBody();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    // 🔒 A hostile — or simply broken — provider streaming gigabytes into a process that is also
    // serving pages. The bound is 64 MiB, so this stops at a thousand chunks and not at the disk.
    await expect(provider().embed(['x'])).rejects.toThrow(/larger than one step may hold/);
    // 64 MiB in 64 KiB chunks is 1024 of them, plus the one that crosses the bound.
    expect(produced()).toBeLessThan(1030);
  });

  // One batch is one unit of the `embeddings` gate (docs/05 §5.4b): a vectorization that sends four
  // batches asks the provider four times, and each of them waits its turn.
  it('sends every batch through the embeddings gate', async () => {
    const gates = new ServiceGates(new FixedClock());
    const run = vi.spyOn(gates, 'run');
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(Response.json({ data: [{ index: 0, embedding: vector(0) }] })),
    );
    const embeddings = provider({}, gates);

    await embeddings.embed(['first']);
    await embeddings.embed(['second']);
    // A batch with nothing in it never reaches the provider, so it takes no slot either.
    await embeddings.embed([]);

    expect(run.mock.calls.map(([service]) => service)).toEqual(['embeddings', 'embeddings']);
  });

  it('bounds the error detail it quotes from a failing provider', async () => {
    const { response, produced } = endlessBody();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(response.body, { status: 500, statusText: 'Server Error' }),
    );

    // The detail goes into the step error for the admin panel, so it is read — but a failure is not
    // a licence to send a gigabyte either: 64 KiB, which is a thousand times more than a sentence.
    await expect(provider().embed(['x'])).rejects.toThrow(/failed with 500/);
    expect(produced()).toBeLessThan(4);
  });
});
