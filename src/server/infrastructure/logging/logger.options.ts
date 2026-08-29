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

// 🔒 Which of a request's headers a log line may repeat (docs/06 §6.7).
//
// An allow-list, and the same one the response side keeps below, for the same reason. Nothing this
// application reads today puts a secret in a request header that is not already named — `Cookie`,
// `Authorization` and the two upload file-name headers were a deny-list of four, and a deny-list
// has to be told about each secret in advance (SEC-23). The candidate nobody would have added is
// `Referer`: a browser is kept from sending it by `Referrer-Policy: no-referrer` (docs/12 §12.8a),
// which is a rule about browsers and not about the next client to follow an invite or reset link
// out of a chat window — and those links carry a bearer credential in their path (docs/08 §8.1.2,
// §8.1.6), which is exactly what `routeShapedUrl` exists to keep out of the log.
//
// What survives is what the line is read for, and the mirror of the response's three: what kind of
// request, how big, who says they sent it, and where they say they sent it from. `Origin` is on the
// list and `Referer` is not, because an origin is a scheme, a host and a port and can hold no path
// to carry a token — and a fail-closed 403 from `csrfOriginCheck` (docs/08 §8.4) is unanswerable
// without it. `Host` is off it: the address the app answers under is `APP_BASE_URL`, which the
// operator already knows.
const LOGGED_REQUEST_HEADERS = ['content-type', 'content-length', 'user-agent', 'origin'] as const;

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
  const headers: Record<string, string> = {};
  for (const name of LOGGED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  return {
    id: req.id,
    method: req.method,
    url: routeShapedUrl(req.url),
    headers,
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
// uploaded document, anything a URL carries beyond the route it matched, and every header of either
// half of the line that is not on one of the two lists above — `Set-Cookie` among them, dropped by
// omission rather than by name.
//
// There is no `redact` block. There used to be one, naming `Cookie`, `Authorization` and the two
// upload file-name headers, and every path in it is now unreachable: the request serializer no
// longer copies a header it was not asked for, so a redact path could only ever match something the
// serializer already dropped. A rule that can never fire is a claim about a defence that is not
// where it says it is (SEC-58 retired the response half of the same list for the same reason).
export function buildPinoHttpOptions(config: AppConfig) {
  const base = {
    level: config.get('LOG_LEVEL'),
    genReqId: (_req: IncomingMessage, res: ServerResponse): string => {
      const id = randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    serializers: { req: serializeRequest, res: serializeResponse },
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
