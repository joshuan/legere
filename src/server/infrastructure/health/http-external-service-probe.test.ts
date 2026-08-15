import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { loadConfig } from '../config/app-config';
import { HttpExternalServiceProbe } from './http-external-service-probe';

// The probe is one GET and a verdict, so what a test has to pin down is which address was asked,
// what went on the wire with it, and how each answer is read (docs/05 §5.4c).
function probe(overrides: Record<string, string> = {}): HttpExternalServiceProbe {
  return new HttpExternalServiceProbe(
    loadConfig({
      DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
      APP_BASE_URL: 'http://localhost:3000',
      AUTH_SECRET: 'test-secret-minimum-32-characters!!',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
      STIRLING_URL: 'http://stirling:8080',
      ...overrides,
    }),
  );
}

type FetchSpy = MockInstance<typeof fetch>;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

// A status that may carry no body must be built with none, or the Response constructor refuses it —
// and Stirling's own status endpoint is one of the ones that answers 204.
function answers(status: number): FetchSpy {
  const body = status === 204 || status === 304 ? null : '{}';
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(new Response(body, { status })));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HttpExternalServiceProbe', () => {
  describe('what it asks, and where', () => {
    it('asks each service the question that service publishes', async () => {
      const fetchSpy = answers(200);
      const subject = probe({
        DOCLING_URL: 'http://docling:5001',
        EMBEDDINGS_API_BASE_URL: 'http://ollama:11434/v1',
      });

      await subject.check('stirling');
      await subject.check('docling');
      await subject.check('embeddings');

      expect(fetchSpy.mock.calls.map((call) => urlOf(call[0]))).toEqual([
        'http://stirling:8080/api/v1/info/status',
        'http://docling:5001/health',
        'http://ollama:11434/v1/models',
      ]);
    });

    it('sends the service its own bearer token, and sends none where there is none', async () => {
      const fetchSpy = answers(200);
      const subject = probe({
        EMBEDDINGS_API_BASE_URL: 'http://ollama:11434/v1',
        EMBEDDINGS_API_KEY: 'sk-embeddings',
      });

      await subject.check('embeddings');
      await subject.check('stirling');

      const headers = fetchSpy.mock.calls.map((call) => new Headers(call[1]?.headers));
      expect(headers[0]?.get('authorization')).toBe('Bearer sk-embeddings');
      expect(headers[1]?.get('authorization')).toBeNull();
    });

    // The analyst falls back to the embeddings endpoint when it has none of its own (docs/12 §12.4).
    // 🔒 The panel has to say the address that is actually called, or it is worse than saying nothing.
    it('follows the analyst to the endpoint it really calls', async () => {
      const fetchSpy = answers(200);
      const subject = probe({
        EMBEDDINGS_API_BASE_URL: 'http://ollama:11434/v1',
        EMBEDDINGS_API_KEY: 'sk-shared',
      });

      const result = await subject.check('classifier');

      expect(urlOf(fetchSpy.mock.calls[0]?.[0] ?? '')).toBe('http://ollama:11434/v1/models');
      expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
        'Bearer sk-shared',
      );
      expect(result.url).toBe('http://ollama:11434/v1');
    });

    it('asks nothing at all where no address is configured', async () => {
      const fetchSpy = answers(200);

      const result = await probe().check('docling');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        url: '',
        status: 'NOT_CONFIGURED',
        httpStatus: null,
        latencyMs: null,
        detail: null,
      });
    });
  });

  describe('how it reads an answer', () => {
    it('reads 2xx as up', async () => {
      answers(204);
      const result = await probe().check('stirling');

      expect(result.status).toBe('UP');
      expect(result.httpStatus).toBe(204);
      expect(result.latencyMs).not.toBeNull();
    });

    it('reads a refusal as a key rather than a host', async () => {
      answers(401);
      expect((await probe().check('stirling')).status).toBe('UNAUTHORIZED');

      answers(403);
      expect((await probe().check('stirling')).status).toBe('UNAUTHORIZED');
    });

    // 404 from a provider without `/models` and 502 from a container still starting are the same
    // sentence with different repairs, so the code travels instead of a verdict.
    it('reads any other code as answered, and carries the code', async () => {
      answers(502);
      const result = await probe().check('stirling');

      expect(result.status).toBe('ANSWERED');
      expect(result.httpStatus).toBe(502);
    });

    it('reads nothing coming back as down, in the transport’s own words', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND stirling'));

      const result = await probe().check('stirling');

      expect(result.status).toBe('DOWN');
      expect(result.httpStatus).toBeNull();
      expect(result.detail).toBe('getaddrinfo ENOTFOUND stirling');
    });
  });

  // 🔒 This string is about to be shown on a screen and copied into a bug report.
  describe('what it publishes', () => {
    it('strips credentials out of the address it reports', async () => {
      answers(200);

      const result = await probe({
        DOCLING_URL: 'https://operator:hunter2@docling.example.com',
      }).check('docling');

      expect(result.url).toBe('https://docling.example.com');
      expect(result.url).not.toContain('hunter2');
    });

    it('strips them out of an address it cannot even parse', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unreachable'));

      const result = await probe({ DOCLING_URL: 'operator:hunter2@docling' }).check('docling');

      expect(result.url).not.toContain('hunter2');
    });

    it('leaves an ordinary address exactly as configured', async () => {
      answers(200);

      const result = await probe({ DOCLING_URL: 'http://docling:5001' }).check('docling');

      expect(result.url).toBe('http://docling:5001');
    });
  });
});
