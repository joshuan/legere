# 19. Personal archive references

Available since [v0.39.0](https://github.com/joshuan/legere/releases/tag/v0.39.0).

This contract implements the Legere requirements in Rent Manage's
`docs/23-legere-documents.md`. It complements the isolated upload namespace in
[18](18-service-integration-guide.md): a service can obtain explicit permission to
read an existing personal archive and save references instead of uploading copies.

## 19.1 Authorization

The issuer is the operator-configured HTTPS Legere origin. Discover
`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/api/integrations/archive`.
The exact resource is `${issuer}/api/integrations/archive`; its only scope is
`documents:read`. Each grant binds one resource/scope pair. MCP keeps its existing
resource and `mcp:read`; neither permission grants access to the other API.

Register a backend client once at `POST /api/oauth/register` with an exact HTTPS
callback, `scope: "documents:read"`, `grant_types: ["authorization_code",
"refresh_token"]`, `response_types: ["code"]` and
`token_endpoint_auth_method: "client_secret_basic"`. Store the returned ID and
secret only on the backend. Registration fixes one supported scope for the client;
existing clients default to `mcp:read`. Client names are self-declared, not verified brands.

Use authorization code with S256 PKCE at `/oauth/authorize`. Send `client_id`,
`redirect_uri`, `response_type=code`, `scope=documents:read`, the exact `resource`,
`state`, `code_challenge` and `code_challenge_method=S256`. Legere requires its
normal login and explicit consent to reading the user's own personal documents.
Bind one-time state and verifier to the consumer's session, user, issuer and
callback; validate state, expiry and response `iss` before exchanging the code.
This is delegated document access, not login or email-based account linking.

Exchange at `POST /api/oauth/token` using Basic client authentication and form
fields `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`,
`resource`. OAuth responses use the standard, unenveloped shape:

```json
{
  "access_token": "legere_…",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "…",
  "scope": "documents:read"
}
```

Codes expire after two minutes; access tokens last at most 15 minutes. Grants and
refresh tokens expire 90 days from consent. Refresh with the same client and
resource; an optional scope must match. Rotation consumes the refresh token once;
replay revokes its entire family, including a concurrent winner. Serialize refresh
in the consumer database per connection and reload credentials after acquiring the
lock. After an ambiguous lost refresh response, reconnect instead of blind retry.
`POST /api/oauth/revoke` uses form encoding and client authentication; revoking
either token ends the whole grant and is idempotent. Settings disconnect, account
deactivation and administrator password recovery also revoke grants.

## 19.2 Read API

Every route below requires an active OAuth grant for exactly this resource/scope.
Cookies, personal tokens, MCP tokens and integration-namespace tokens are refused.
Responses have `Cache-Control: no-store`; successes use `{ "data": ... }`.

| Method and route | `data` |
| --- | --- |
| `GET /api/integrations/archive/me` | `{ subject: UUID, displayName: string }` |
| `GET /api/integrations/archive/documents` | `{ items: ArchiveDocument[], nextCursor: string \| null }` |
| `GET /api/integrations/archive/documents/:id` | `ArchiveDocument` |
| `GET /api/integrations/archive/documents/:id/canonical` | `{ url, expiresAt, contentType: "application/pdf" }` |
| `GET /api/integrations/archive/documents/:id/preview` | `{ url, expiresAt, contentType: "image/jpeg" }` |

`subject` is the immutable Legere user UUID, stable across grants and rotation.
The strict document DTO contains only `id`, `title`, nullable `description`,
`createdAt` (ISO timestamp), nullable `documentDate` (`YYYY-MM-DD`), nullable
`pageCount`, nullable `documentType: { id, slug, name }`, `processing`, the existing
six `steps`, and `url`. The URL is an ordinary `/documents/:id` Legere page requiring
the viewer's own session and permissions. It is not a public share capability.

Eligibility is identical for lists, detail and artifacts: a live DOCUMENT profile
created by the grant's subject, with no integration namespace and no library-origin
pages. Administrator status never broadens this set. Receipts, deleted documents,
shared documents owned by others and ownerless library documents are excluded.
No journal, paths, OCR, historical files or unrelated links are exposed.

List parameters are strict: `q` is trimmed and at most 300 characters; `limit` is
an integer from 1 through 100, default 30; `cursor` is opaque. Search is a
case-insensitive literal substring of title or description, with no SQL wildcards
or highlighting. Order is `createdAt DESC, id DESC`. Cursors bind the subject,
normalized query and order. Access filters run before pagination. Unknown query
fields, malformed identifiers and invalid cursors fail validation.

Artifacts are independently ready only when their own step is DONE. Their signed
URL TTL is the instance's `SIGNED_URL_TTL_SEC`. A reference follows the current
document; artifact keys can be overwritten. Neither `updatedAt` nor a saved URL
represents an immutable revision or snapshot.

Errors use `{ error: { code, message, details: null } }`: 401 UNAUTHENTICATED for
missing/expired/revoked credentials; 403 FORBIDDEN for the wrong permission or an
inactive owner; 404 DOCUMENT_NOT_FOUND for every unavailable/ineligible document;
409 CANONICAL_NOT_READY or DOCUMENT_UNAVAILABLE for an unfinished artifact;
422 VALIDATION_FAILED or CURSOR_SORT_MISMATCH for input/cursor errors; and
429 RATE_LIMITED with Retry-After. The archive read routes share a separate per-user
budget of 120 requests per minute, enough for a maximum-size page and its previews. OAuth errors remain standard OAuth responses.

OpenAPI is published at `/api/openapi.json`. There is no version request header.
Consumers check discovery and strict response DTOs: missing resource/scope/routes
means the operator must update Legere. Network failures are separate. Never fall
back to a personal token, an administrator token or a hidden browser session.

## 19.3 Consumer responsibilities

Only the connection owner browses the archive. Attaching a selected document is an
explicit consumer action warning that apartment members will receive access. Save
connection ID, issuer, subject and document ID. Other members may read only a live
attachment, never browse the owner's archive or supply arbitrary remote IDs.
Every read verifies the consumer session, reader and connection-owner membership,
attachment and connection, then calls Legere again. Reconnecting a different
subject must not rebind previous references. Revocation, removal, deletion or
denial makes the attachment unavailable; do not fall back to cached files.

Prefer an authorized backend artifact proxy. Allow only configured HTTPS storage
origins; reject unexpected redirects, bound time and size, support Range and use
safe Content-Disposition. Do not log secrets, cookies, codes or signed URLs, or
store signed URLs as durable identities. An already issued signed URL remains a
capability until expiry; revocation cannot retract it instantly.

Consumer membership, attachment UI, encrypted credential persistence and proxy
implementation belong to Rent Manage. Its acceptance includes owner/member/
outsider isolation, both membership removals, reconnecting as a different subject,
refresh races, safe proxy failures and responsive localized UI. Legere's tests
cover the upstream authorization, eligibility, pagination and artifact contract.
