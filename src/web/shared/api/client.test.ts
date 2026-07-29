import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ERROR_CODES } from '../../../shared/contracts/common';
import { ApiError, fieldIssuesOf } from './api-error';
import { request } from './client';
import { ERROR_MESSAGE_KEYS } from './error-messages';

const schema = z.object({ id: z.string(), name: z.string() });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api client', () => {
  it('unwraps the envelope and returns validated data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: { id: '1', name: 'Doc' } }),
    );

    await expect(request('GET', '/api/things/1', { schema })).resolves.toEqual({
      id: '1',
      name: 'Doc',
    });
  });

  it('sends same-origin credentials and a JSON body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ data: { id: '1', name: 'Doc' } }));

    await request('POST', '/api/things', { schema, body: { name: 'Doc' } });

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init?.credentials).toBe('include');
    expect(init?.body).toBe(JSON.stringify({ name: 'Doc' }));
  });

  it('appends defined query parameters only', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ data: { id: '1', name: 'Doc' } }));

    await request('GET', '/api/things', {
      schema,
      query: { limit: 30, cursor: undefined, processing: true },
    });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/things?limit=30&processing=true');
  });

  it('throws a typed ApiError carrying the code and details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request validation failed',
            details: { issues: { fieldErrors: { email: ['Invalid email'] }, formErrors: [] } },
          },
        },
        422,
      ),
    );

    const error = await request('POST', '/api/things', { schema }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.status).toBe(422);
    // Field issues map back onto form fields (docs/10 §10.6).
    expect(fieldIssuesOf(error)).toEqual({ email: ['Invalid email'] });
  });

  it('reports a network failure as ApiError NETWORK', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));

    const error = await request('GET', '/api/things', { schema }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.code).toBe('NETWORK');
    expect(error.status).toBe(0);
  });

  it('fails loudly when the response does not match the contract', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: { id: 1, name: 'Doc' } }));

    await expect(request('GET', '/api/things/1', { schema })).rejects.toBeInstanceOf(ApiError);
  });

  it('treats a non-envelope error body as an internal failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>502</html>', { status: 502 }),
    );

    const error = await request('GET', '/api/things', { schema }).catch((e: unknown) => e);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.code).toBe('INTERNAL');
    expect(error.status).toBe(502);
  });
});

describe('error message map', () => {
  it('covers every contract error code plus NETWORK', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGE_KEYS[code]).toBeTruthy();
    }
    expect(ERROR_MESSAGE_KEYS.NETWORK).toBeTruthy();
    expect(Object.keys(ERROR_MESSAGE_KEYS)).toHaveLength(ERROR_CODES.length + 1);
  });
});
