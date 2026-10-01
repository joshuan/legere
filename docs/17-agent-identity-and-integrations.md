# 17. Agent identity, delegated MCP access and service integrations

## 17.1. Identity and attribution

A credential identifies an application acting **for** a user; it never replaces the user. Every
new machine-created archive item and user-authored history event stores an immutable attribution
snapshot `{kind, id, name, clientId?}`. Kinds are `API_TOKEN`, `OAUTH` and `INTEGRATION`. An API
token's name is its agent label; an OAuth grant's client name and stable client ID identify its
application; an integration's name identifies the service. Secrets and hashes are never exposed.
Browser actions have no agent, and old records remain unattributed rather than being guessed.

Document creators, receipt owners and history actors render the person's name with a smaller,
readable secondary line, “via Codex token” / “через Codex token”. The same shared component is
used wherever those actor identities appear. Attribution survives credential expiry, revocation,
rotation and archive-kind conversion. User directories describe people, not historical actions,
and do not invent a single agent for a person with several credentials.

## 17.2. MCP OAuth

Legere remains an email/password and session application. It additionally acts as an OAuth
authorization server for its own MCP resource, not as an external identity provider for login.
This is the explicitly requested extension to the earlier no-OAuth rule in docs/08.

The public resource is `APP_BASE_URL/api/mcp`. Discovery is available at
`/.well-known/oauth-protected-resource/api/mcp` (also the root protected-resource alias) and
`/.well-known/oauth-authorization-server`. Unauthenticated MCP requests include a Bearer
`WWW-Authenticate` challenge naming that metadata. MCP OAuth grants only `mcp:read`: the existing
read-only archive tools, under the consenting user's current visibility. Personal `READ` API
tokens remain supported. OAuth tokens cannot read other REST routes or mint credentials.

Clients register through `POST /api/oauth/register` (RFC 7591). Public clients use `none` and
PKCE; confidential clients may use `client_secret_basic` or `client_secret_post`. Client names
are supplied by the client, not proof of brand identity: consent displays the redirect origin
and client ID as well as the name. Client metadata URLs are not fetched by the server.

`GET /oauth/authorize` requires the existing login and explicit consent, with an origin-protected
session-only confirmation. The authorization-code flow requires S256 PKCE, exact registered
redirect URI matching, `response_type=code`, the canonical MCP `resource`, and a supported scope.
Invalid redirect URIs never receive redirects. Callbacks echo state and include issuer `iss`
(RFC 9207). HTTPS redirects are required, with HTTP allowed only for loopback development.

`POST /api/oauth/token` accepts form-encoded authorization-code and refresh-token grants. Codes
are short-lived, single-use and bound to user, client, redirect, resource and PKCE challenge.
Access tokens are opaque, hashed at rest, short-lived and audience-bound. Refresh tokens rotate
atomically; replay revokes their grant. `POST /api/oauth/revoke` is idempotent. Public credential endpoints
limit requests and input sizes; secrets and authorization query strings are omitted from logs.
Anonymous dynamic registration also has an instance-wide ceiling of 10,000 client records,
enforced under a database lock, so changing source addresses cannot grow that table without bound.
Existing clients remain usable at the ceiling; an operator must remove unused registrations
before admitting more. Registration does not silently expire previously issued client credentials.
The settings page lists connected applications and lets the user revoke a grant. Revocation,
account deactivation and administrative password recovery invalidate delegated access too.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth),
[OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700).

## 17.3. Service isolation

An **Integration** is a named, user-owned namespace, such as Rent Manage. A session creates it
and issues expiring, revocable `INTEGRATION` API tokens bound to its immutable ID. Multiple
credentials can be rotated without losing access to existing documents. Revoking the integration
disables all its credentials; individual token revocation does not delete its documents.

The dedicated `/api/integrations/documents` API supports raw-byte upload with
`X-Legere-Filename`, cursor-paginated listing, detail, canonical PDF and JPEG preview URLs.
Every lookup includes the authenticated integration ID and owner, even for an administrator's
token. Foreign and missing IDs are indistinguishable 404s. Integration credentials cannot use
ordinary REST, MCP, library, search, sharing, file, user or settings routes.

The server assigns the namespace at creation. Clients cannot claim an existing personal document
or supply an owner/namespace. Same-content retries within the namespace return the existing ID
with `created: false`; a duplicate outside it returns a generic conflict without its ID or
metadata. Concurrent same-namespace retries converge on the same document. Existing global
file deduplication and the single archive-product home remain intact.

The service response is a bounded document projection: identity, title, metadata, processing
state and an ordinary Legere document link. It exposes no unrelated document links, library
paths, earlier files, user directory or history. Canonical and preview artifacts use the same
short-lived signed URLs as the archive. A service keeps its token on its backend, obtains URLs
there, and refreshes them when expired; it can embed the PDF/JPEG or proxy the bytes to its own
authorized users. A signed URL is a temporary capability for that one artifact, not archive
access. A Legere page link still requires a Legere session. Artifact readiness is explicit.

People can view and edit integration documents through their ordinary archive permissions.
Integration membership stays with the archive item across profile conversion; the document API
does not expose receipt profiles. Cross-namespace composition must not silently widen a service's
access to another document's content. Explicit integration-document content editing by its owner
is an update to content already entrusted to that service.

## 17.4. API documentation and verification

Serve a public OpenAPI 3.1 document for the integration API and a readable, repository-owned
setup guide covering token issuance/rotation, upload/dedup, pagination, polling readiness,
artifact expiry, browser embedding and access boundaries. OAuth discovery is authoritative for
OAuth clients; OpenAPI describes the REST integration contract.

Verification covers durable attribution and rendering; discovery and a complete OAuth consent,
code, token, refresh and MCP call; PKCE, redirect, audience and replay failures; revocation and
account recovery; two integrations for one owner and integrations owned by an administrator;
dedup races, pagination, canonical/preview boundaries, ordinary-route rejection and OpenAPI.
The normal typecheck, lint, coverage, browser, dependency and release-image gates remain intact.

The separate personal archive resource and `documents:read` permission are specified in
[`19`](19-personal-archive-integration.md). They do not expand MCP or namespace credentials.
