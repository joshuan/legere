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
  window.location.assign(`${LOGIN_PATH}?returnTo=${returnTo}`);
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

export const apiClient = {
  get: <T>(path: string, options: RequestOptions<T>): Promise<T> => request('GET', path, options),
  post: <T>(path: string, options: RequestOptions<T>): Promise<T> => request('POST', path, options),
  patch: <T>(path: string, options: RequestOptions<T>): Promise<T> =>
    request('PATCH', path, options),
  delete: <T>(path: string, options: RequestOptions<T>): Promise<T> =>
    request('DELETE', path, options),
};
