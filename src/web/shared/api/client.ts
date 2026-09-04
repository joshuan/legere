import type { ZodType } from 'zod';
import { errorBodySchema } from '../../../shared/contracts/common';
import { ApiError } from './api-error';

// Same-origin API client (docs/10 §10.5). Every response is unwrapped from the envelope and
// validated against the contract schema the caller passes, so a server/client drift surfaces
// immediately rather than as a confusing render failure downstream.

export type RequestOptions<T> = {
  schema: ZodType<T>;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
};

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

// Where an unauthenticated caller is sent. Public routes render their own 401 handling instead.
const LOGIN_PATH = '/login';
const PUBLIC_PATH_PREFIXES = ['/login', '/onboarding', '/invite/', '/reset/'];

function buildUrl(path: string, query: RequestOptions<unknown>['query']): string {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString === '' ? path : `${path}?${queryString}`;
}

// A 401 outside the public routes means the session died mid-session: bounce to login, preserving
// where the user was so they land back there afterwards (docs/10 §10.2, §10.5).
function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search } = window.location;
  if (PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return;

  const returnTo = encodeURIComponent(`${pathname}${search}`);
  window.location.assign(new URL(`${LOGIN_PATH}?returnTo=${returnTo}`, window.location.origin));
}

export async function request<T>(
  method: Method,
  path: string,
  options: RequestOptions<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw new ApiError('NETWORK', 0);
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = errorBodySchema.safeParse(payload);
    if (parsed.success) {
      if (parsed.data.error.code === 'UNAUTHENTICATED') redirectToLogin();
      throw new ApiError(
        parsed.data.error.code,
        response.status,
        parsed.data.error.details ?? null,
      );
    }
    // Not an envelope at all (a proxy error page, say) — report it as an internal failure.
    if (response.status === 401) redirectToLogin();
    throw new ApiError('INTERNAL', response.status);
  }

  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    throw new ApiError('INTERNAL', response.status);
  }

  const parsed = options.schema.safeParse(payload.data);
  if (!parsed.success) {
    // Loud in dev, tolerated in prod: a shape mismatch is a bug, but it should not blank the page
    // for a user when only one field drifted (docs/10 §10.5).
    if (process.env.NODE_ENV !== 'production') {
      throw new ApiError('INTERNAL', response.status, parsed.error.flatten());
    }
    throw new ApiError('INTERNAL', response.status);
  }

  return parsed.data;
}

// How much of the file has left the browser so far, as the transport counts it off (docs/11 §11.3).
export type UploadProgress = (loadedBytes: number, totalBytes: number) => void;

// A body that failed to parse is not an error in itself — an empty one, or a proxy's HTML — so it is
// treated the same way `response.json()` is above: as nothing at all.
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The one request that is not JSON: the file itself is the body, and its name rides in a header
// because a body cannot carry both (docs/07 §7.3).
//
// XMLHttpRequest rather than fetch, for the one thing fetch cannot do: say how many bytes of the
// body have actually gone up, which is what a hundred-megabyte scan needs a progress bar for
// (docs/11 §11.3). Everything else — the envelope, the error model — is what `request` does.
export function uploadFile<T>(
  path: string,
  file: File,
  options: { schema: ZodType<T>; signal?: AbortSignal; onProgress?: UploadProgress },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { onProgress, signal } = options;
    if (signal !== undefined && signal.aborted) {
      reject(new ApiError('NETWORK', 0));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', file.type === '' ? 'application/octet-stream' : file.type);
    // Percent-encoded: headers are Latin-1, and file names are not.
    xhr.setRequestHeader('X-Legere-Filename', encodeURIComponent(file.name));

    if (onProgress !== undefined) {
      xhr.upload.onprogress = (event) => {
        // A chunked or compressed body has no total to be a fraction of; silence beats a wrong bar.
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      };
    }

    // A transport that never produced a response — offline, refused, aborted — is the one failure
    // that carries no status.
    const failed = () => reject(new ApiError('NETWORK', 0));
    xhr.onerror = failed;
    xhr.onabort = failed;
    xhr.ontimeout = failed;

    xhr.onload = () => {
      const status = xhr.status;
      const payload: unknown = parseBody(xhr.responseText);

      if (status < 200 || status >= 300) {
        const error = errorBodySchema.safeParse(payload);
        if (error.success) {
          if (error.data.error.code === 'UNAUTHENTICATED') redirectToLogin();
          reject(new ApiError(error.data.error.code, status, error.data.error.details ?? null));
          return;
        }
        reject(new ApiError('INTERNAL', status));
        return;
      }

      if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
        reject(new ApiError('INTERNAL', status));
        return;
      }

      const parsed = options.schema.safeParse(payload.data);
      if (!parsed.success) {
        reject(new ApiError('INTERNAL', status));
        return;
      }
      resolve(parsed.data);
    };

    if (signal !== undefined) {
      const abort = () => xhr.abort();
      signal.addEventListener('abort', abort, { once: true });
      // Whatever ended the request, the signal outlives it and must not keep the handler.
      xhr.onloadend = () => signal.removeEventListener('abort', abort);
    }

    xhr.send(file);
  });
}

export const apiClient = {
  get: <T>(path: string, options: RequestOptions<T>): Promise<T> => request('GET', path, options),
  post: <T>(path: string, options: RequestOptions<T>): Promise<T> => request('POST', path, options),
  patch: <T>(path: string, options: RequestOptions<T>): Promise<T> =>
    request('PATCH', path, options),
  delete: <T>(path: string, options: RequestOptions<T>): Promise<T> =>
    request('DELETE', path, options),
};
