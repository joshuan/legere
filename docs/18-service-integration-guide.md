# Connecting applications to Legere

For references to documents already in a user’s personal archive, use the separate
[personal archive OAuth contract](19-personal-archive-integration.md). This chapter
covers documents uploaded into an isolated service namespace.

This guide covers service-owned documents and OAuth MCP. The [identity and authorization
contract](17-agent-identity-and-integrations.md) defines the security boundaries.

## Choose the credential

| Caller | Credential | Access |
| --- | --- | --- |
| Rent Manage or another document backend | A named **integration** token | Upload, list and read only documents in that integration |
| ChatGPT or another OAuth MCP client | OAuth authorization code with PKCE | Read/search the authorizing user's archive through MCP |
| Existing agent or email importer | Personal READ, DOCUMENTS_INGEST or RECEIPTS_INGEST token | Its existing personal-token scope |

MCP is currently read-only, including OAuth connections. OAuth is delegated access, not a new
login provider: the user signs in to Legere and approves the named application. Do not give a
service a personal READ token when it only needs its own documents.

## Rent Manage: provision once

1. Sign in to `https://legere.joshuan.ru/settings` as the document owner.
2. Under **Integrations**, create `Rent Manage` and issue a token. Choose a descriptive token name
   and expiry. Copy the secret immediately; Legere stores only its hash.
3. Store the secret in the Rent Manage backend's secret configuration. Never embed it in browser
   JavaScript, a query string, an iframe URL or mobile application code.
4. Keep the integration ID. For rotation, issue another token **on the same integration**, switch
   the backend, then revoke the old token in Settings → API tokens. Recreating the integration
   creates a new namespace and does not recover the old namespace's access.

Each integration belongs to one Legere user. For a multi-user Rent Manage deployment, provision
an integration per Legere owner and store the mapping in Rent Manage. An integration is a trusted
backend credential: it is not a replacement for Rent Manage's own tenant/user authorization.

The public [OpenAPI 3.1 contract](https://legere.joshuan.ru/api/openapi.json) can be imported into
API tooling or a client generator. It describes the five operations below, response schemas,
authentication and errors. The public schema contains no credentials or account data.

## Upload and save the ID

All service calls use `Authorization: Bearer <integration-token>`. Send raw file bytes; the
filename is UTF-8 percent-encoded in `X-Legere-Filename`. This endpoint does **not** take multipart.

For this example, keep the integration token in a backend-only file with mode `0600`, such as
`~/.config/legere/rent-manage-token.txt`. The personal receipt-upload token at
`~/.config/legere/token.txt` is a different credential and does not authorize this API.

```python
#!/usr/bin/env python3
import json
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

BASE = "https://legere.joshuan.ru"
TOKEN = Path("~/.config/legere/rent-manage-token.txt").expanduser().read_text().strip()

def call(path, *, body=None, headers=None):
    request = Request(
        BASE + path,
        data=body,
        headers={"Authorization": "Bearer " + TOKEN, **(headers or {})},
        method="GET" if body is None else "POST",
    )
    with urlopen(request, timeout=120) as response:
        return json.load(response)["data"]

# Check that the token currently grants integration access before sending the file.
call("/api/integrations/documents?limit=1")

file = Path("lease.pdf")
result = call(
    "/api/integrations/documents",
    body=file.read_bytes(),
    headers={
        "Content-Type": "application/octet-stream",
        "X-Legere-Filename": quote(file.name, safe=""),
    },
)
document_id = result["document"]["id"]
document_url = result["document"]["url"]
print(json.dumps({"id": document_id, "url": document_url, "created": result["created"]}))
# Persist document_id next to the lease record in Rent Manage.
```

Both a new upload and a retry return HTTP **201**. `data.created` is `true` for a new document;
`false` means the same bytes already exist **inside this integration**. In both cases,
`data.document.id` is the ID to save. Concurrent retries resolve to that same ID. The original
creator/application attribution is preserved on a duplicate.

Legere deduplicates file content instance-wide. Bytes already held by a different integration,
a personal document or a receipt produce **409**, without disclosing the other item's ID.
Do not retry that conflict indefinitely or substitute a personal admin token. This release does
not expose an API to import an existing personal document into an integration.

## Metadata, processing and pagination

```text
GET /api/integrations/documents/{id}
GET /api/integrations/documents?limit=30
GET /api/integrations/documents?limit=30&cursor=<URL-encoded-nextCursor>
```

Every successful reply uses `{ "data": ... }`. A list returns `items` and `nextCursor`; stop when
the latter is `null`. The default limit is 30, the maximum 100, newest first. Do not decode or
construct cursors. Additional query parameters are rejected so a caller cannot choose a different
owner, integration or administrative scope.

The document response contains `id`, `title`, `description`, `createdAt`, `documentDate`,
`pageCount`, `processing`, `steps`, `url`, `ownerId` and `createdVia`. It deliberately omits
cross-document links, library paths, the archive journal and shared catalogue metadata.
`createdVia` identifies the stable integration, for example:

```json
{ "kind": "INTEGRATION", "id": "42c9c22b-2671-4b17-837c-a701c252ea09", "name": "Rent Manage" }
```

Processing starts asynchronously. Poll the detail with backoff (for example 2, 4, 8, then 15
seconds), and stop on a completed or failed relevant step. A PDF can be ready while later OCR
and analysis are still running. Use `steps.canonical === "DONE"` and
`steps.preview === "DONE"` independently. Do not treat `processing: false` as proof of success.

## Display a PDF or JPEG

```text
GET /api/integrations/documents/{id}/canonical
GET /api/integrations/documents/{id}/preview
```

The response is `{ "data": { "url": "...", "expiresAt": "...", "contentType": "..." } }`.
Canonical is the complete PDF, preview is the first-page JPEG. Each check applies the integration
boundary before signing. A not-yet-ready artifact returns **409**. These are URL responses, not
redirects and not the artifact bytes themselves.

Rent Manage should call this API in its backend after checking that its own user may view the
lease. Return the short-lived URL to the browser and use it in an `<iframe src="...">` for the PDF
or `<img src="...">` for the preview. Alternatively, proxy the artifact through Rent Manage's
authenticated backend. Never forward the Legere integration token to the browser.

Treat a signed URL as a temporary bearer capability: anyone holding it can read that artifact
until `expiresAt`, including after token/integration revocation. Obtain fresh URLs on demand;
store the document ID rather than a signed URL. The object store must be reachable over HTTPS
from the displaying browser; configure Legere's external S3 endpoint accordingly. Cross-origin
canvas pixel reads may additionally require bucket CORS. Ordinary `<img>` display needs no
integration-token CORS permission from Legere.

`data.document.url` is a permanent link to the Legere viewer. Opening it requires a Legere login
and the normal document access rights. It is not a public sharing link. Embedding the authenticated
Legere application itself is not part of this contract; embed the signed PDF/JPEG instead.

## Revocation and errors

The browser owner may inspect/edit their integration documents in Legere. Combining or moving
pages across integrations (including between personal and integration documents) is refused.
Split parts preserve the namespace. If a document is converted to a receipt it disappears from
the document API; converting it back restores access to the same ID and namespace. Deleting a
document makes it unavailable. Revoking an integration does not delete its documents or attribution.

| Status | Meaning and action |
| --- | --- |
| 401 | Missing, expired or revoked credential; rotate/reconnect |
| 403 | Wrong credential scope or inactive owner; check provisioning |
| 404 | Missing/deleted/out-of-scope document; do not infer its existence |
| 409 | Duplicate outside the namespace, incompatible archive kind, or artifact not ready; inspect `error.code` |
| 413 | Over the instance upload limit (`UPLOAD_MAX_BYTES`, default 100 MiB) |
| 415 | Unsupported file format |
| 422 | Invalid filename, UUID, query or input |
| 429 | Rate limited; honor `Retry-After` and use backoff |

Errors use `{ "error": { "code": "...", "message": "...", "details": null } }`. Branch on
`code`, not the English diagnostic message. Use request IDs from response headers when reporting
a failed call. Avoid logging tokens, authorization headers, OAuth codes or signed artifact URLs.

## Connect ChatGPT or another OAuth MCP client

In the cloud agent's custom MCP connector, enter:

```text
MCP server: https://legere.joshuan.ru/api/mcp
Authentication: OAuth
Scope: mcp:read
```

Legere publishes protected-resource metadata and authorization-server discovery. An OAuth client
can dynamically register (DCR), or use the client ID/secret returned by a prior DCR registration.
Public clients use `token_endpoint_auth_method: "none"`; confidential clients can use
`client_secret_basic` or `client_secret_post`. Register exact HTTPS redirect URIs; loopback HTTP
redirects are allowed for local development. No wildcard redirect URIs are accepted.

The client opens `/oauth/authorize` with `response_type=code`, `client_id`, exact `redirect_uri`,
`scope=mcp:read`, `resource=https://legere.joshuan.ru/api/mcp`, `state`, `code_challenge` and
`code_challenge_method=S256`. After login, Legere shows the user, application name, client ID,
callback origin and requested archive access. Approval returns an opaque code plus `state` and
`iss`; denial returns `access_denied`. Client names are self-declared, so the consent screen also
shows the callback origin and client ID.

Exchange the code at `/api/oauth/token` using form encoding, `grant_type=authorization_code`,
`code`, exact `redirect_uri`, `code_verifier` and the same `resource`; authenticate the registered
client using its chosen method. Codes expire after two minutes and can be used once. Access
tokens last at most 15 minutes. Refresh tokens rotate on every exchange, with a 90-day connection
lifetime; include `grant_type=refresh_token`, `refresh_token` and `resource`. Serialize refresh
attempts: replaying an already consumed code/refresh token revokes the connection's token family.

The user can disconnect an application in Settings → Connected applications. An OAuth client
can revoke its access or refresh token at `/api/oauth/revoke`. Password resets and account
deactivation also end the connection. OAuth tokens are accepted only at the bound MCP resource,
not at REST upload/document/admin endpoints. Historical attribution uses the authorizing Legere
user plus the connection's immutable application name, grant ID and registered client ID.

No external OAuth provider, external login, OpenAI API key or separate OAuth server is required.
Configure `APP_BASE_URL` to the public HTTPS origin, preserve `Authorization` at the reverse proxy,
and allow the public `/.well-known/*`, `/api/oauth/*` and `/api/mcp` endpoints. Cookie-authenticated
consent stays protected by the normal same-origin check. Client ID Metadata Documents (CIMD)
are not advertised; use DCR or preregistration instead.

Protocol references: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
and [OpenAI OAuth integration](https://developers.openai.com/plugins/build/auth).

## Personal receipt references

Receipt references use the existing owner/admin receipt API and a personal READ token; neither
an integration token nor `documents:read` OAuth grants receipt access. OpenAPI identifies these
operations with the separate `personalReadToken` security scheme. Keep the token on a trusted
backend. Persist issuer + the selected receipt ID.

A confirmed duplicate remains readable at `GET /api/receipts/:id`, including its original
artifacts. Inspect `data.reference.state`: REPLACED supplies a readable `replacementId`;
MERGE_UNDONE supplies `restoredReceiptIds` in original order. Follow related IDs explicitly,
checking their own state for later decisions; an unavailable target is null/absent. The response
never changes identity and artifact reads never redirect. Preserve the attachment's original
ID even when displaying the replacement. Previously copied amounts require an explicit consumer
refresh; there is no change feed or webhook. Explicit deletion, conversion, revoked credentials
and permission loss still make reads unavailable. Details and examples are in
[receipt review](21-receipt-duplicates.md#durable-receipt-references).
