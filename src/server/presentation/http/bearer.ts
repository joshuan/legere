import type { Request } from 'express';

const BEARER_SCHEME = 'bearer ';

// The token out of `Authorization: Bearer <token>`, or undefined when the header is absent or uses
// another scheme (docs/08 §8.2a). Parsing lives here rather than in a use case: this is HTTP.
export function bearerTokenOf(req: Request): string | undefined {
  const header = req.get('authorization');
  if (header === undefined || !header.toLowerCase().startsWith(BEARER_SCHEME)) return undefined;

  const token = header.slice(BEARER_SCHEME.length).trim();
  return token === '' ? undefined : token;
}
