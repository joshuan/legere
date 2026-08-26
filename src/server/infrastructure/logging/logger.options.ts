import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { SerializedRequest, SerializedResponse } from 'pino';
import { AppConfig } from '../config/app-config';

// 🔒 How much of a URL a log line may repeat (docs/06 §6.7).
//
// A path segment survives only when it is plainly part of a route — lower-case letters and hyphens,
// no longer than a word: `api`, `documents`, `password-resets`. Everything else becomes `:x`, so
// what reaches the log is the shape of the route and not the values travelling in it.
//
// It is an allow-list rather than an exception for the two routes that carry a credential in a path
// today (`GET /api/invites/:token`, `GET /api/password-resets/:token` — docs/08 §8.1.2, §8.1.6).
// Those tokens are bearer secrets living seven days and one day; a log is read by more people than
// a database is — `docker compose logs app`, a shipped log, a support bundle pasted into an issue —
// and the next route to put a secret in a path would not think to add itself to a deny-list.
// Identifiers share their fate here: `requestId` already ties a line to the rest of its request,
// and handlers log the ids they act on deliberately (docs/06 §6.7).
//
// The matched Express route (`req.route.path`) would name the parameters — `:token` rather than
// `:x` — and is deliberately not used: it is empty exactly when a request never reached its handler
// (throttled, refused by the origin check, an unknown route), which is when a URL carrying a token
// is most likely to be the one being logged.
const ROUTE_LITERAL = /^[a-z][a-z-]{0,23}$/;
const OPAQUE_SEGMENT = ':x';

export function routeShapedUrl(url: string): string {
  // The query string goes whole, unread. `GET /api/search?q=…` is what somebody searched their own
  // archive for, which is as private as the archive itself; nothing else in a query is worth a rule
  // of its own to keep, and a per-parameter allow-list would have the deny-list's weakness.
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  return path
    .split('/')
    .map((segment) => (segment === '' || ROUTE_LITERAL.test(segment) ? segment : OPAQUE_SEGMENT))
    .join('/');
}

// Everything of a request that reaches a log line. Written as what is *kept*, so that the fields
// dropped from pino's standard shape are dropped by omission and a new one has to be added on
// purpose: `query` and `params` are the two that matter — Express fills both, and both hold
// precisely what the URL above is scrubbed of (`params.token` is the invite token, spelled out).
export type LoggedRequest = Pick<
  SerializedRequest,
  'id' | 'method' | 'url' | 'headers' | 'remoteAddress' | 'remotePort'
>;

// pino-http wraps a custom `req` serializer around the standard one, so what arrives here is
// already the serialized shape, and what is returned *is* the `req` of the log line.
export function serializeRequest(req: LoggedRequest): LoggedRequest {
  return {
    id: req.id,
    method: req.method,
    url: routeShapedUrl(req.url),
    headers: req.headers,
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

// 🔒 Which of a response's headers a log line may repeat (docs/06 §6.7).
//
// An allow-list, for the reason the URL above is one. Two headers this application sets on the way
// out are precisely what a log may not hold: `Location` on a download's 302 is a presigned URL — a
// bearer credential for the bytes behind it, good for SIGNED_URL_TTL_SEC with no session, no cookie
// and no token (docs/09 §9.2) — and `Content-Disposition`, set on both branches of a download,
// spells out the file name the request side is already scrubbed of. Naming those two in a
// deny-list would have held until the third one: SEC-23's lesson is that a deny-list of secrets is
// the wrong shape, and it applies to headers as much as to configuration (SEC-58).
//
// What survives says how the request ended and nothing about what it carried. `X-Request-Id` is not
// here because `req.id` on the same line already is it, and the constant security headers would say
// the same thing on every line.
const LOGGED_RESPONSE_HEADERS = ['content-type', 'content-length', 'retry-after'] as const;

export type LoggedResponse = Pick<SerializedResponse, 'statusCode' | 'headers'>;

// Like the request serializer, this is wrapped around pino's standard one, so `headers` is already
// what `res.getHeaders()` returned — lower-cased names, as they stood when the response finished.
// It takes what it keeps, not the whole serialized shape: `raw` is pino's non-enumerable handle on
// the response object, and nothing here has a reason to hold it.
export function serializeResponse(res: LoggedResponse): LoggedResponse {
  const headers: Record<string, string> = {};
  for (const name of LOGGED_RESPONSE_HEADERS) {
    const value = res.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  return { statusCode: res.statusCode, headers };
}

// pino-http options (docs/06 §6.7). Every request gets a uuid requestId (echoed as X-Request-Id and
// attached to logs). Sensitive material is never logged: cookies, auth headers, the name of an
// uploaded document, anything a URL carries beyond the route it matched, and every response header
// but the three above — `Set-Cookie` among them, dropped by omission rather than by name.
export function buildPinoHttpOptions(config: AppConfig) {
  const base = {
    level: config.get('LOG_LEVEL'),
    genReqId: (_req: IncomingMessage, res: ServerResponse): string => {
      const id = randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    serializers: { req: serializeRequest, res: serializeResponse },
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        // 🔒 The name of a file is often the most sensitive metadata an archive holds — one
        // "biopsy-results.pdf" says what a folder of PDFs does not — and an upload carries it in a
        // header, since the body is the file itself (docs/07 §7.3). Both spellings the upload
        // routes accept.
        'req.headers["x-legere-filename"]',
        'req.headers["x-file-name"]',
      ],
      remove: true,
    },
  };

  // Pretty transport in development only; production emits JSON to stdout — and so does a test run,
  // because a transport is a worker thread and what it writes the process can no longer read back,
  // which is exactly what a test about what does *not* reach a log line has to do.
  return config.get('NODE_ENV') === 'development'
    ? { ...base, transport: { target: 'pino-pretty' } }
    : base;
}

export function buildLoggerOptions(config: AppConfig): Params {
  return { pinoHttp: buildPinoHttpOptions(config) };
}
