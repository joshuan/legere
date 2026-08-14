import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ERROR_CODES } from '../../../shared/contracts/common';
import { ApiError, fieldIssuesOf } from './api-error';
import { request, uploadFile } from './client';
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
  vi.unstubAllGlobals();
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

// Just enough XMLHttpRequest for the upload path: what was sent is recorded, and the test plays the
// server's side by hand — jsdom has no transport, and the point of the exercise is the event order.
type ProgressTick = { lengthComputable: boolean; loaded: number; total: number };

class FakeUpload {
  onprogress: ((event: ProgressTick) => void) | null = null;
}

class FakeXhr {
  static last: FakeXhr | undefined = undefined;

  method = '';
  url = '';
  withCredentials = false;
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = '';
  upload = new FakeUpload();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onloadend: (() => void) | null = null;

  constructor() {
    FakeXhr.last = this;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: unknown): void {
    this.body = body;
  }

  abort(): void {
    this.onabort?.();
    this.onloadend?.();
  }

  progress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.onprogress?.({ lengthComputable, loaded, total });
  }

  respond(status: number, body: unknown): void {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
    this.onloadend?.();
  }

  fail(): void {
    this.onerror?.();
    this.onloadend?.();
  }
}

function lastXhr(): FakeXhr {
  const xhr = FakeXhr.last;
  if (xhr === undefined) throw new Error('no upload was started');
  return xhr;
}

describe('uploadFile', () => {
  const file = new File(['0123456789'], 'счёт 7.pdf', { type: 'application/pdf' });

  beforeEach(() => {
    FakeXhr.last = undefined;
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });

  it('posts the bytes with credentials, the file type and the encoded name', async () => {
    const promise = uploadFile('/api/documents', file, { schema });
    const xhr = lastXhr();
    xhr.respond(200, { data: { id: '1', name: 'Doc' } });

    await expect(promise).resolves.toEqual({ id: '1', name: 'Doc' });
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/documents');
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers['Content-Type']).toBe('application/pdf');
    expect(xhr.headers['X-Legere-Filename']).toBe(encodeURIComponent('счёт 7.pdf'));
    expect(xhr.body).toBe(file);
  });

  it('falls back to a generic content type when the file has none', async () => {
    const promise = uploadFile('/api/documents', new File(['x'], 'scan'), { schema });
    const xhr = lastXhr();
    xhr.respond(200, { data: { id: '1', name: 'Doc' } });

    await promise;
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('reports bytes as they leave, and only while the total is known', async () => {
    const onProgress = vi.fn();
    const promise = uploadFile('/api/documents', file, { schema, onProgress });
    const xhr = lastXhr();
    xhr.progress(4, 10);
    xhr.progress(7, 0, false);
    xhr.progress(10, 10);
    xhr.respond(200, { data: { id: '1', name: 'Doc' } });

    await promise;
    expect(onProgress.mock.calls).toEqual([
      [4, 10],
      [10, 10],
    ]);
  });

  it('throws a typed ApiError carrying the code and details', async () => {
    const promise = uploadFile('/api/documents', file, { schema });
    lastXhr().respond(422, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details: { issues: { fieldErrors: { file: ['Unsupported format'] }, formErrors: [] } },
      },
    });

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.status).toBe(422);
    expect(fieldIssuesOf(error)).toEqual({ file: ['Unsupported format'] });
  });

  it('treats a non-envelope error body as an internal failure', async () => {
    const promise = uploadFile('/api/documents', file, { schema });
    lastXhr().respond(502, '<html>502</html>');

    const error = await promise.catch((e: unknown) => e);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.code).toBe('INTERNAL');
    expect(error.status).toBe(502);
  });

  it('fails when the response does not match the contract', async () => {
    const promise = uploadFile('/api/documents', file, { schema });
    lastXhr().respond(200, { data: { id: 1, name: 'Doc' } });

    await expect(promise).rejects.toBeInstanceOf(ApiError);
  });

  it('reports a network failure as ApiError NETWORK', async () => {
    const promise = uploadFile('/api/documents', file, { schema });
    lastXhr().fail();

    const error = await promise.catch((e: unknown) => e);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.code).toBe('NETWORK');
    expect(error.status).toBe(0);
  });

  it('aborts the request when the signal does, and reports it the same way', async () => {
    const controller = new AbortController();
    const promise = uploadFile('/api/documents', file, { schema, signal: controller.signal });
    controller.abort();

    const error = await promise.catch((e: unknown) => e);
    if (!(error instanceof ApiError)) throw new Error('expected an ApiError');
    expect(error.code).toBe('NETWORK');
    expect(error.status).toBe(0);
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
