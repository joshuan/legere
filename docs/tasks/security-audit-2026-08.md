# Security audit — August 2026

A full read of the codebase against the threat model of [`01 §1.2`](../01-vision-and-scope.md): a
self-hosted instance an administrator deploys, holding scanned identity documents, contracts and
invoices, with a read-only library volume, closed registration, and two roles (`ADMIN`, `USER`).

The register below is the evidence behind milestone **M15** in [`backlog.md`](./backlog.md). Each
finding has a stable id (`SEC-nn`); backlog tasks reference those ids, so a task can be traced to the
code path it came from and back. Nothing here has been fixed — this document records the state of
the tree at `v0.6.0` (`a56af49`).

## Method

Six parallel reviews, each reading code paths end to end rather than pattern-matching: authentication
and sessions; authorization and IDOR; injection and input validation; files, storage and outbound
calls; deployment, configuration and logging; the client. Findings were then re-verified against the
source before being recorded. `npm audit` was run against the committed lockfile.

## Who the attacker is

Three positions worth separating, because severity depends on which one a finding needs:

- **Anonymous** — can reach `/api/auth/*`, `/api/invites/:token`, `/api/password-resets/:token` and
  `/api/health`, plus every Next page.
- **`USER`** — a signed-in account. Can upload documents, so **can put arbitrary bytes into the
  processing pipeline** (sharp, Stirling, Docling, the analyst, the Markdown the viewer renders).
  This is the position most findings below assume, and it is the one the product hands to every
  invited person.
- **Whoever reads the logs** — an operator, a log shipper, anyone sent a support bundle. Treated as a
  distinct principal because two findings hand this principal live credentials.

## Severity

| | Meaning |
|---|---|
| **High** | Account takeover, cross-user data disclosure, or loss of the instance, reachable by an attacker in one of the positions above |
| **Medium** | Requires a precondition the attacker does not fully control, or yields disclosure/denial short of takeover |
| **Low** | Real but narrow: needs an unguessable value, an admin mistake, or yields only correctness/fingerprinting |
| **Info** | No exploit today; a documented property that is not actually enforced, or a landmine for the next change |

## Summary

| Id | Severity | Finding |
|---|---|---|
| [SEC-01](#sec-01) | High | A share can be re-shared: a private document reaches the whole instance |
| [SEC-02](#sec-02) | High | `returnTo` is an unvalidated open redirect after a successful login |
| [SEC-03](#sec-03) | High | An uploaded `.html` is stored as `text/html` and served from a presigned URL without `nosniff` |
| [SEC-04](#sec-04) | High | An invite is not single-use: one link mints unlimited accounts, including admins |
| [SEC-05](#sec-05) | High | `trust proxy` is unconditional, so per-IP rate limiting is bypassable by a header |
| [SEC-06](#sec-06) | High | No security headers at all: no CSP, no `frame-ancestors`, no HSTS |
| [SEC-07](#sec-07) | High | Production dependencies with known vulnerabilities, `sharp`/`libvips` on untrusted images |
| [SEC-08](#sec-08) | High | No pixel budget on `sharp`: one image bomb kills the single process |
| [SEC-09](#sec-09) | High | The application container runs as root with no hardening |
| [SEC-10](#sec-10) | High | Invite and reset tokens are written to the request log in plaintext |
| [SEC-11](#sec-11) | Medium | Prompt injection into the analyst exfiltrates and poisons shared catalogues |
| [SEC-12](#sec-12) | Medium | Email-keyed login backoff is a remote account-lockout weapon |
| [SEC-13](#sec-13) | Medium | The document event log discloses file paths inside invisible libraries |
| [SEC-14](#sec-14) | Medium | The app is given MinIO **root** credentials |
| [SEC-15](#sec-15) | Medium | The example `AUTH_SECRET` and S3 credentials are accepted in production |
| [SEC-16](#sec-16) | Medium | `excludeGlobs` reaches picomatch unbounded: catastrophic backtracking wedges a scan |
| [SEC-17](#sec-17) | Medium | No timeout and no response-size limit on any outbound call |
| [SEC-18](#sec-18) | Medium | The default deployment prints verification codes to the log |
| [SEC-19](#sec-19) | Medium | An invite is not bound to its `emailHint`: email bombing and 24 h reset denial |
| [SEC-20](#sec-20) | Medium | Uploads and library files are buffered whole in memory, uncapped |
| [SEC-21](#sec-21) | Medium | CI has no `permissions:` block, floating action tags, and no dependency scanning |
| [SEC-22](#sec-22) | Medium | The dev stack publishes five services on `0.0.0.0`, one with authentication disabled |
| [SEC-23](#sec-23) | Medium | Instance-page redaction is a deny-list: a new secret leaks by default |
| [SEC-24](#sec-24) | Medium | Password-reset completion revalidates neither the reset nor the account |
| [SEC-25](#sec-25) | Medium | `ts_headline` over unbounded Markdown, with no `statement_timeout` anywhere |
| [SEC-26](#sec-26) | Low | `DELETE /collections/:id/shares/:shareId` does not scope the share to the collection |
| [SEC-27](#sec-27) | Low | The CSRF check covers `/api` only, with nothing enforcing that it stays sufficient |
| [SEC-28](#sec-28) | Low | Concurrent `register/verify` widens the five-attempt window on an email code |
| [SEC-29](#sec-29) | Low | LIKE metacharacters from `?path=` reach the browse query unescaped |
| [SEC-30](#sec-30) | Low | The upload filename sanitizer is newline-blind |
| [SEC-31](#sec-31) | Low | `resolvesInsideRoot` is never called: an intermediate symlink escapes the volume |
| [SEC-32](#sec-32) | Low | The body-parser bypass covers one upload route of the two |
| [SEC-33](#sec-33) | Low | Polynomial backtracking on the Markdown table-separator regex |
| [SEC-34](#sec-34) | Low | No security event logging: nothing records logins, resets or role changes |
| [SEC-35](#sec-35) | Low | Sessions: 30-day absolute TTL, no rotation, no self-service revocation, no password change |
| [SEC-36](#sec-36) | Low | `/api/health` is unauthenticated and unthrottled, and hits the database per call |
| [SEC-37](#sec-37) | Info | `X-Powered-By` is advertised by both Express and Next |
| [SEC-38](#sec-38) | Info | Invite and reset tokens travel in a URL path segment |
| [SEC-39](#sec-39) | Info | PDF isolation depends on an unasserted `S3_PUBLIC_ENDPOINT` ≠ `APP_BASE_URL` invariant |
| [SEC-40](#sec-40) | Info | Catalogue endpoints expose names and counts mined from restricted content |
| [SEC-41](#sec-41) | Info | A cross-library `combine` permanently widens access to restricted content |
| [SEC-42](#sec-42) | Info | Read-only bearer enforcement is single-layer, though `08 §8.2a` claims two |
| [SEC-43](#sec-43) | Info | `npx prisma migrate deploy` at container start, with runtime DDL rights |
| [SEC-44](#sec-44) | Info | An unvalidated cursor answers 500 instead of 422 |
| [SEC-45](#sec-45) | Info | The security checklist of `08 §8.6` has never been ticked |

---

## High

### SEC-01
**A share can be re-shared: a private document reaches the whole instance**

`src/server/infrastructure/persistence/prisma-document.repository.ts:157-178` (Prisma dialect) and
`:308-328` (the raw-SQL dialect search uses).

[`03 §3.3.15`](../03-domain-model.md) says sharing grants read access to the documents in a
collection **that their owner created**. The predicate never checks that: the share branch asks only
that the document has no library file and that *some* live collection containing it is owned by the
viewer or shared with them. `document.createdById = collection.ownerId` is absent from both
dialects.

**Attack.** A uploads a private document `D` and shares collection `C_A` containing it with B. B now
reads `D` legitimately — and can add `D` to their own collection `C_B` (`AddCollectionItem`,
`manage-collections.ts:166`, checks only `findReadableById(D, B)`, which passes *because of A's
share*). B then shares `C_B` instance-wide. Every active user can read `D`, its canonical PDF, its
Markdown and find it in search. A sees nothing: `GET /api/collections/C_A/shares` still lists only B.
Revoking A's share does not undo it — `C_B` still contains `D`.

**Options.**

1. **Add the owner condition to the predicate** (recommended). One clause in each dialect fixes read
   *and* search at once; the existing `c.owner_id = viewer` alternative collapses into the
   `d.created_by_id = viewer` branch, so the predicate gets simpler rather than larger. A grantee who
   adds a borrowed document to their own collection then sees it and shares nothing — needs a line of
   UI copy so that is not surprising.
2. **Refuse the add**: `AddCollectionItem` rejects a document the caller did not create. Fails at the
   moment of the mistake, which reads better in an audit log — but it breaks the legitimate "curate a
   collection of library documents" case, and repairs nothing already laundered.
3. **Document-level ACLs.** Most expressive, disproportionate here, and contradicts `03 §3.4`.

Whichever is chosen, a backfill query is needed to find items already laundered.

### SEC-02
**`returnTo` is an unvalidated open redirect after a successful login**

`src/web/screens/login/login-screen.tsx:15` reads `params.get('returnTo')`;
`src/web/features/login-form/login-form.tsx:26` and
`src/web/features/auth-wizard/auth-wizard.tsx:120` pass it straight to `router.replace()`. Next's
app router classifies an off-origin href as external and performs a real `location.replace()`.

**Attack.** `https://legere.internal/login?returnTo=https://legere-intern4l.example/login`. The host
is genuine, the login page is genuine, the credentials reach the real server and a real session is
created — and then the browser lands on a clone saying "session expired, sign in again". On an
archive of identity documents this is a high-value credential phish, and it defeats every other
control because it attacks the human after authentication rather than the authentication.

Protocol-relative `//evil.example/x` passes the same way. `javascript:` needs empirical
confirmation — `new URL('javascript:…', base).origin` is `"null"`, so it is classified external and
reaches `location.replace` — and if it fires it is arbitrary script in the app origin with no CSP
([SEC-06](#sec-06)) to stop it. **Test that case before deciding this is only a redirect.**

**Fix.** A `safeReturnTo()` helper in `src/web/shared/lib`, applied at **both** sinks rather than at
the one read site: resolve against `window.location.origin` and keep only
`pathname + search + hash` when the origins match. One comparison covers absolute URLs, `//host`,
backslash variants and `javascript:`.

### SEC-03
**An uploaded `.html` is stored as `text/html` and served from a presigned URL without `nosniff`**

The chain, each link verified:

| Step | Where |
|---|---|
| MIME falls back to the **filename extension** when magic bytes fail, and `TEXT_EXTENSIONS` maps `html`/`htm` → `text/html` | `src/server/infrastructure/library/file-type-mime-detector.ts:18-29, 44-53` |
| `looksLikeText` accepts anything without a NUL byte in the head | `:63-65` |
| that MIME becomes the S3 object's `ContentType` | `upload-document.ts:113`, `compose-document.ts:126` → `s3-file-storage.ts:48-58` |
| a managed original is served as a **302 to a presigned URL** | `download-document.ts:81-86` |
| the redirect branch returns **before** the `nosniff` + `Content-Disposition` block | `documents.controller.ts:343-345` vs `:348-357` |
| the presign carries no response-header overrides | `s3-file-storage.ts:71-75` |

**Attack.** Any `USER` uploads `report.html` containing a script. Anyone who opens
`GET /api/documents/:id/files/:fileId/content` is redirected to the presigned URL and the script runs
in the storage origin. `evil.xml` works the same way via `application/xml` and an `xml-stylesheet`
processing instruction pointing at a second uploaded object.

**Impact depends on topology.** With `S3_PUBLIC_ENDPOINT` on the app origin — a normal reverse-proxy
layout — this is same-origin XSS: cookies are `HttpOnly`, but scripted `fetch` from that origin
satisfies the CSRF origin check, so it is admin account takeover via any document an admin opens.
With a separate origin (the shipped default) it is confined to the storage origin, which is still
phishing from the operator's own infrastructure. See [SEC-39](#sec-39).

**Options.**

1. **Override the response headers in the presign** (recommended) — `ResponseContentDisposition` and
   `ResponseContentType` on the `GetObjectCommand`. One choke point, fixes every object already in
   the bucket, and the signature covers the overrides so they cannot be stripped. The preview and
   canonical paths need `inline` plus their real type, so the port learns a "how is this served"
   argument.
2. **Normalize the stored `ContentType`** to `application/octet-stream` for anything off a render
   allow-list, keeping the detected MIME on the row for display. Two lines — but it does not fix
   objects already stored, and the next code path that presigns without thinking is unprotected.
3. **Stop redirecting for originals** and stream them through the app, so the existing `nosniff` +
   `attachment` block applies uniformly. One rule for all file serving; gives up range requests, and
   the canonical viewer depends on presigned ranges, so this fits `…/files/:fileId/content` only.

Do 1 or 3; add 2 as depth.

### SEC-04
**An invite is not single-use: one link mints unlimited accounts, including admins**

`src/server/application/auth/complete-registration.ts:93` loads the invite by id and checks only
`invite === null`. `isInviteValid()` — which tests `revokedAt`, `acceptedAt` and `expiresAt` —
is applied at `start-registration.ts:128` and in the preview, and **never at completion**.

**Attack.** Start a registration series per address against the same invite token (the 60-second gate
is per `(email, purpose)`, so different addresses are not serialized), verify each, then complete
each ticket. Every completion re-reads the invite, finds it, and copies `invite.role`. `markAccepted`
merely overwrites `acceptedById`. With an `ADMIN` invite this yields several admin accounts from one
link, and the extra accounts are **persistence**: the admin panel shows one acceptance, so
deactivating the visible account leaves the shadows intact.

This contradicts [`08 §8.1.2`](../08-auth-and-authorization.md) ("single-use link") and its own §8.6
checklist. The existing test covers re-*starting* after acceptance, which is why it was missed.

**Fix.** Re-check `isInviteValid` inside the completion transaction, and make `markAccepted` a
conditional write (`updateMany where acceptedAt: null`, `count === 0` → `INVITE_INVALID`) — Prisma
transactions here are READ COMMITTED, so two simultaneous completions would otherwise both see
`acceptedAt = null`.

### SEC-05
**`trust proxy` is unconditional, so per-IP rate limiting is bypassable by a header**

`server/main.ts:33` sets `trust proxy` to `1` unconditionally, and the shipped deployment publishes
the app straight onto the host (`deploy/docker-compose.yaml:70-71`) with no proxy in the stack.
`@nestjs/throttler` keys on `req.ip`, which Express then reads from a client-supplied
`X-Forwarded-For`.

Every request with a fresh header value lands in a fresh bucket. The consequences:

- **Argon2 flooding.** `login.ts:59` runs a full Argon2id verify (19 MiB, t=2) even for addresses
  nobody registered, and the per-email backoff is sidestepped by using a new address each time.
  `argon2` runs on the libuv threadpool (4 by default), so this is queue saturation: every login and
  registration stalls. Nothing crashes and restarts — it simply hangs.
- Unlimited `register/start` (see [SEC-19](#sec-19)), unlimited probing of
  `GET /api/invites/:token` and `/api/password-resets/:token`.

The per-email backoff still caps guessing against one account, so what remains is unthrottled
enumeration, distributed guessing across many accounts, and cost amplification.

**Options.**

1. **`TRUST_PROXY` config, defaulting to off** (recommended). Correct for both topologies; an
   operator behind a proxy who forgets to set it gets over-throttling, which is the safe direction.
2. **Ship a reverse proxy in `deploy/docker-compose.yaml`** and stop publishing the app port. Also
   brings TLS, which the `Secure`-cookie derivation already rewards — but it is a heavier default.
3. **Regardless of 1 or 2:** put a concurrency semaphore around `PasswordHasher.hash/verify` (say 4
   in flight, 429 beyond) so no future keying mistake can become a threadpool DoS.

### SEC-06
**No security headers at all**

No helmet, no `Content-Security-Policy`, no `frame-ancestors`, no `Strict-Transport-Security`, no
`Referrer-Policy`, no `Permissions-Policy`. `next.config.mjs` defines no `headers()`. The single
`X-Content-Type-Options` in the tree is `documents.controller.ts:357`, on the streamed branch only.

Clickjacking is fully open on a document viewer, and every XSS in this register is unmitigated.

**Options.** Whichever is chosen, the policy must be built from `AppConfig` at boot, not written as a
static string: presigned URLs send the browser to `S3_PUBLIC_ENDPOINT`, a different origin, so
`img-src`/`connect-src` have to include it. HSTS must be gated on `config.usesHttps` — enabling it on
the `http://<lan-ip>` deployments the code deliberately supports would lock operators out.

1. **helmet with a permissive CSP, `Report-Only` first.** ~15 lines; works unchanged with Ant
   Design's CSS-in-JS and Next's inline bootstrap. Delivers `frame-ancestors`, HSTS, nosniff and
   `Referrer-Policy` immediately. But `script-src 'unsafe-inline'` provides close to zero XSS
   mitigation — a floor, not a defence, and easy to mistake for one.
2. **Nonce-based CSP.** A per-request nonce threaded through `@ant-design/nextjs-registry` and Next's
   scripts gives a real `script-src 'self' 'nonce-…' 'strict-dynamic'` — which is what actually stops
   the XSS in [SEC-03](#sec-03). Highest friction: nonces disable static optimization, and the
   interaction with the custom Express dispatcher needs care. Budget a day plus a pass over every
   Ant Design surface.
3. **Split the surfaces** (recommended as the first move): ship the non-CSP headers globally now, and
   a strict `default-src 'none'` CSP on `/api` responses only, deferring the page CSP to a tracked
   task. Immediate, zero UI risk, and the JSON surface gets the strong policy for free.

Recommended: 3 now, 2 as a tracked follow-up. Not 1 alone.

### SEC-07
**Production dependencies with known vulnerabilities**

`npm audit` on the committed lockfile: 10 vulnerabilities, 1 critical, 7 high. Production-relevant:

| Package | What |
|---|---|
| `sharp` <0.35 | Inherited libvips CVE-2026-33327/33328/35590/35591 — **and sharp decodes untrusted images from uploads and the library** |
| `nodemailer` ≤9.0.0 | SMTP command injection, CRLF header injection, `raw`-option arbitrary file read and SSRF, address-parser DoS |
| `next` | SSRF in rewrites, cache confusion, image-optimizer DoS, unauthenticated disclosure of internal server-function endpoints |
| `next-intl` | Open redirect, prototype pollution via translation-catalog keys |
| `postcss`, `file-type` | XSS via stringify output; infinite loop on malformed input |

`sharp` and `nodemailer` need major bumps. Nothing in CI would ever have reported this — see
[SEC-21](#sec-21).

### SEC-08
**No pixel budget on `sharp`: one image bomb kills the single process**

`src/server/infrastructure/pdf/sharp-image-tool.ts` sets neither `limitInputPixels` nor
`sharp.cache()` nor `sharp.concurrency()`. sharp's default limit is a ceiling (~268 Mpx), not a
budget. `applyCrop` (`:80-105`) decodes straight to **raw** with no prior resize.

A 16383×16383 single-colour PNG compresses to a few hundred KB — far under the 100 MiB
`UPLOAD_MAX_BYTES` — and decodes to ~805 MB of raw RGB; `warpPerspective` then allocates an output
raster of comparable size. Upload it, `PATCH` any crop onto it, and the rebuild detonates. Because
Nest, Next and the pg-boss workers **share one process**, the OOM takes the HTTP surface with it, and
`RETRY_LIMIT = 5` re-detonates the poison pill five times.

**Fix.** `limitInputPixels` plus `sequentialRead` on every constructor, `sharp.cache(false)` and
`sharp.concurrency(1)` at module load. A legitimately huge scan then fails the step loudly into
`skipReasons` instead of taking the process down — the correct trade. Moving image work to a separate
worker is the durable answer but needs an ADR, since `02` fixes the one-process model.

### SEC-09
**The application container runs as root with no hardening**

`Dockerfile:14-26` never drops privileges, and `deploy/docker-compose.yaml:20-71` sets no `user:`,
`cap_drop`, `no-new-privileges`, `read_only` or `mem_limit`. (`deploy/docling/Dockerfile:44` *does*
drop to uid 1001 — the app image is the outlier.)

Combined with [SEC-07](#sec-07) and [SEC-08](#sec-08): the process that decodes attacker-supplied
images through a native library with four open CVEs is uid 0, with full default capabilities and a
writable root filesystem, holding the MinIO root credentials ([SEC-14](#sec-14)) and the Postgres
owner role ([SEC-43](#sec-43)).

### SEC-10
**Invite and reset tokens are written to the request log in plaintext**

Both credentials travel in a path segment — `GET /api/invites/:token`
(`invites.controller.ts:15`) and `GET /api/password-resets/:token`
(`password-resets.controller.ts:14`). `pino-http` logs the request `url` through the standard
serializer at `info`, the default level in `deploy/docker-compose.yaml:34`, and the redact list
(`logger.options.ts:16-19`) names exactly three header paths and nothing about URLs.

Anyone who can read `docker compose logs app`, a shipped log, or a support bundle a user pasted into
an issue can replay a live invite (7 days) or reset token (24 hours). This contradicts
[`08 §8.1.2`](../08-auth-and-authorization.md) — "it is a bearer secret — never logged" — and the
§8.6 checklist, so it is a code-versus-doc deviation and not merely a design opinion.

Also unredacted, and worth a deliberate decision: `x-legere-filename` (document filenames are often
the most sensitive metadata a DMS holds) and `req.query` on `/api/search` (what people search for).

**Fix.** A custom `req` serializer that logs a route-shaped URL (`/api/invites/:token`), plus the two
filename headers on the redact list. Moving the tokens out of the URL entirely
([SEC-38](#sec-38)) is the better end state and needs a `07` change first.

---

## Medium

### SEC-11
**Prompt injection into the analyst exfiltrates and poisons shared catalogues**

`src/server/infrastructure/ai/openai-compat-analyst.ts:236` interpolates the document excerpt into a
fixed, guessable `"""` fence with no escaping and no delimiter randomization. The excerpt is the
document's own OCR'd Markdown — fully controlled by anyone who can upload.

The output validators are genuinely good (`pickSlug` allow-lists against the slugs actually sent, every
field is shape- and length-checked), so misclassification into an invented type is not possible. Two
consequences survive:

1. **Cross-user disclosure.** The prompt embeds up to 60 known subjects with 300-character notes from
   the **instance-wide** catalogue. A document can instruct the model to echo that list into
   `description`, which the attacker reads back on their own document — a repeatable exfiltration
   primitive for other users' subject names and notes.
2. **Catalogue poisoning.** `people` and `subjects` from the analyst create catalogue rows: up to 8
   arbitrary names and 5 `{kind, name}` pairs per document, rendered in every user's UI.

**Options.** (a) nonce-delimited fence, stripping the nonce from the excerpt — five lines, kills the
fence escape but not an obedient model; (b) put catalogue and instructions in the `system` message
and the excerpt alone in `user`, stating that user content is data — cheap, standard, soft; (c) stop
co-locating the catalogue with untrusted text, or scope it to what the document's owner can already
see — kills the disclosure outright at some cost to classification quality; (d) require confirmation
before a *new* catalogue row is created, letting analysis link to existing ones freely — kills the
poisoning permanently, adds a review step. Recommended: a+b+c for disclosure, d for poisoning.

### SEC-12
**Email-keyed login backoff is a remote account-lockout weapon**

`login.ts:51` checks `retryAfterMs(email)` before anything else; the streak is keyed on the email and
doubles to a 15-minute cap, cleared only by a *successful* login.

Five wrong passwords, then one request every fifteen minutes, and the victim can never sign in — the
backoff is checked before the password is even looked at, so knowing the correct password does not
help. Roughly 96 requests a day per victim; the per-IP throttle does not slow it, and
[SEC-05](#sec-05) removes that anyway.

This is what [`08 §8.4`](../08-auth-and-authorization.md) specifies, so **the weakness is in the
spec** — the doc has to change before the code does. The email-keyed choice is deliberate and does
defeat the distributed-IP attack that IP keying misses; the flaw is that it has no counterweight.

**Options.** (a) verify the password first and apply the backoff only on the failure path, so the
legitimate owner is never locked out — but the Argon2 verify then runs before the cheap gate, which
needs [SEC-05](#sec-05) option 3 alongside it; (b) key on `(email, ip)`, capping the per-email delay
low and letting the per-IP one grow — an attacker with many IPs regains speed unless a CAPTCHA is
required after N failures; (c) replace lockout with a mandatory CAPTCHA after N failures — no lockout
at all, but a hard dependency on Turnstile, which is optional today.

Independently: both `InMemoryLoginAttempts` and `InMemoryEmailSendThrottle` are process-local, so a
restart loop resets every streak and every daily cap.

### SEC-13
**The document event log discloses file paths inside invisible libraries**

Written at `handle-file-ingest.ts:108-117` and `:127-142` (`path: ref.path.value`); read at
`manage-documents.ts:56-78`, which redacts `endpoint` for non-admins and nothing else. The control it
bypasses is `prisma-document.repository.ts:869-885`, which filters `refs` to visible libraries with
an explicit 🔒 comment.

Because files are deduplicated instance-wide, the same bytes can be referenced from several
libraries. A user with a grant on library A reads, from the event log of a document they may see, the
path those bytes occupy inside `RESTRICTED` library HR — `hr/terminations/…` — while
`GET /api/documents/:id` correctly hides the same ref. In a DMS the folder structure often *is* the
sensitive part.

**Options.** (a) filter the path by visible library, which needs `libraryId` in the event payload
(forward-only; old rows fall back to redacted); (b) strip `path` from `LIBRARY` events for
non-admins, mirroring the `endpoint` precedent — one line, ships today, loses detail for users who
*could* see the library; (c) stop recording the event on a second-library attach, which loses
provenance `03 §3.3.18` explicitly wants. Recommended: b now, a when the payload gains `libraryId`.

### SEC-14
**The app is given MinIO root credentials**

`deploy/docker-compose.yaml:46-47` hands `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` to the app as its S3
key. One credential is the object-store administrator, the console login and the app's day-to-day
key. A compromise of the Node process yields not "read and write the `legere` bucket" but "delete
every bucket, make it public, add users" — and the app's key cannot be rotated without rotating
MinIO's root. Fix: a scoped service account limited to `arn:aws:s3:::legere/*`.

### SEC-15
**The example `AUTH_SECRET` and S3 credentials are accepted in production**

`loadConfig` validates shape only. `.env.example:11` ships
`dev-secret-change-me-min-32-chars!!`, which is 35 characters and passes `min(32)`; nothing rejects
the published value, so anyone following `README.md:97` and running the built server has a
**publicly known HMAC key** for email codes. `config.schema.ts:68-69` defaults
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` to `legere`/`legere-secret` — production-valid defaults
published in this repository. `APP_BASE_URL` is not required to be `https://` in production, and
`usesHttps` then silently drops the `Secure` cookie attribute.

The compose path is safe (`deploy/.env.example` ships empty placeholders and
`deploy/docker-compose.yaml` uses `${VAR:?…}` guards); the exposure is the "run it yourself" path.
Fix: a production preflight in `loadConfig` that refuses known example values and warns on plain
HTTP, listing every problem the way the existing error does.

### SEC-16
**`excludeGlobs` reaches picomatch unbounded**

`excludeGlobsSchema` allows 50 globs of 256 characters; picomatch compiles each to a backtracking
regex with no complexity bound, and `fs-library-reader.ts:120` runs it per directory entry. Measured
on this machine: 10 `a*` pairs → 195 ms, 12 → 8.2 s, 14 → 86 s. A glob of `a*a*a*…b` inside the
256-character cap never returns, holding a pg-boss slot and pinning a CPU with no job CPU timeout.

The glob is admin-only, so this is mostly self-inflicted — but the *other* half of the match is the
filename on the volume, which in the external-library model is often written by something other than
the admin. Fix: bound glob complexity at the contract (reject more than ~8 wildcards), or compile
through RE2. Separately, `picomatch.isMatch(str, patterns, opts)` recompiles per call — hoist a
matcher built once per scan.

### SEC-17
**No timeout and no response-size limit on any outbound call**

No `signal`/`AbortSignal.timeout` anywhere in `infrastructure/{pdf,ai,auth}`, and every response is
read whole: `stirling-pdf-toolbox.ts:148-165`, `docling-parser.ts:101-105, 147-154`,
`openai-compat-embeddings.ts:43-51`, `openai-compat-analyst.ts:139`, and
`turnstile-captcha-verifier.ts:34` — the last of which sits on the **login request path**, so a hung
Turnstile holds a handler. undici's 300 s timeouts are the only backstop and a slow drip defeats them
entirely. A wedged Stirling container pins every processing worker; a hostile one returns a
multi-gigabyte body straight into the process.

### SEC-18
**The default deployment prints verification codes to the log**

`SMTP_HOST` is empty in `deploy/.env.example`, so `LogEmailSender` logs the full message body at
`info` — and `deploy/init.sh` tells the operator to read the first admin's code out of the log. It is
deliberate and documented, but the shipped default *is* the unconfigured deployment, there is no
production guard, and combined with [SEC-10](#sec-10) "can read the log" becomes "can register,
verify, reset, and take over any account". Fix: log recipient and subject only, and refuse the
fallback under `NODE_ENV=production` without an explicit opt-in.

### SEC-19
**An invite is not bound to its `emailHint`**

`start-registration.ts:126-132` accepts any `(email, inviteToken)` pair, and the send throttle is keyed
on the address across *both* purposes. An invite holder can therefore send five instance letters to a
victim's address and thereby block `PASSWORD_RESET` codes for that address for 24 hours — an admin
issuing a reset gets `429` and cannot recover the account for a day. Leaving a `REGISTRATION` series
alive also poisons the victim's later reset, because `findUsableSeries`
(`verify-email-code.ts:63-66`) resolves `REGISTRATION` first and the correct reset code fails against
it. Fix: bind the start address to `emailHint` when set, throttle by `(email, purpose)`, and prefer
the series whose code actually matches.

### SEC-20
**Uploads and library files are buffered whole in memory, uncapped**

`readUploadBody` refuses *while streaming* (good), but the accepted body is then held entire through
hashing, MIME detection and the S3 put — 100 MiB each, with no per-user or global concurrent-upload
cap. `toBuffer` (`binary-source.ts:11-13`) has **no cap at all** and `build-canonical.ts:91` calls it
on a library-volume stream: `SCAN_MAX_FILES` bounds the file count, not bytes, so a 5 GB PDF dropped
on the volume is read whole. `docling-parser.ts:165-169` does a full `slice` copy, peaking at 2×.

### SEC-21
**CI supply chain**

`.github/workflows/ci.yml` has **no `permissions:` block**, so `GITHUB_TOKEN` takes the repository
default while running `npm ci` (arbitrary dependency lifecycle scripts) on every push to `main`;
`release.yml` gets this right and should be mirrored. Every third-party action is pinned to a
floating major tag, in a pipeline that holds `packages: write` and publishes
`ghcr.io/joshuan/legere:latest` — which every deployment pulls. There is no `npm audit`, no SCA, no
image scan and no `dependabot.yml`, which is the mechanical reason [SEC-07](#sec-07) went unnoticed.

Verified safe: no untrusted input (PR title, branch, body, author) reaches any `run:` step; the one
value that crosses into a shell uses the correct `env:` indirection; no `pull_request_target`.

### SEC-22
**The dev stack publishes five services on `0.0.0.0`**

`docker-compose.yaml` binds Postgres (`legere/legere`), MinIO plus its **admin console**, Stirling-PDF
with `SECURITY_ENABLELOGIN: 'false'`, Docling and Ollama to every interface. On café or corporate
wifi that exposes an unauthenticated document-conversion service — an SSRF and file-processing
primitive with a native stack — alongside an object-store admin console and a database whose
credentials are printed in this repository. Fix: `127.0.0.1:` prefixes, which cost local development
nothing.

### SEC-23
**Instance-page redaction is a deny-list**

`instance-view.ts:26-35` is, today, **complete and correct** — all eight secret-bearing keys are
listed, `DATABASE_URL` is decomposed without its password, and the endpoint is admin-only. The
problem is structural: `setting()` emits the value of anything *not* named, so the default for a new
key is to leak. A future `OIDC_CLIENT_SECRET` added to the schema and to a group ships to every
admin's browser. Cheapest durable fix, no behaviour change: a test asserting that every schema key
matching `/SECRET|PASSWORD|KEY|TOKEN/` is on the list.

### SEC-24
**Password-reset completion revalidates neither the reset nor the account**

`complete-registration.ts:136` loads the reset by id with no `isPasswordResetValid()` and no
`isUserActive()` check, where `start-registration.ts:110-117` does both. Within the 15-minute ticket
window an admin can deactivate the account — `DeactivateUser` revokes sessions, tokens and pending
resets precisely to close this door — and completion still succeeds, writing the attacker's password
onto a deactivated account. The session issued is inert, but the password is in place if the account
is ever reactivated. Fix: revalidate inside the transaction and make `markUsed` conditional.

### SEC-25
**`ts_headline` over unbounded Markdown, with no `statement_timeout`**

`prisma-document.repository.ts:682-696` runs `ts_headline` over the whole of `documents.markdown` —
an unbounded `text` column holding OCR output — for up to 50 rows per request, and
`websearch_to_tsquery` is evaluated three times per query. There is no `statement_timeout` configured
anywhere. Any signed-in user can loop `GET /api/search?q=<common word>&limit=50` and consume
disproportionate database CPU. Fix: headline over a bounded prefix, hoist the tsquery into a CTE, and
set a `statement_timeout` on the app role.

No injection here: `websearch_to_tsquery` never raises on malformed input, so there is no error-based
DoS either — that choice is correct and worth keeping.

---

## Low and informational

### SEC-26
`RevokeShare` (`manage-collections.ts:242-255`) authorizes the collection but passes `shareId`
straight to `prisma-collection.repository.ts:221-227`, whose `where` has **no `collectionId`**. A user
with any collection of their own can revoke a share belonging to someone else's collection, given its
UUID. Not practically reachable — share ids are UUIDs and only the owner can list them — but it is a
missing tenancy scope on a write, and `removeItem` right above it *is* scoped correctly.

### SEC-27
`csrfOriginCheck` is mounted on `/api` only. Verified currently sufficient: there are no Next route
handlers and no `'use server'` actions anywhere, so every mutation passes through it. The risk is
structural — the day someone adds either, it inherits the `sid` cookie with no origin check. Fix:
move the check above the dispatcher, or add a lint rule forbidding both and say so in `02`.

The check itself is correct: origin comparison including scheme and port, missing `Origin` *and*
`Referer` → 403, `Origin: null` → 403. Fail-closed as documented.

### SEC-28
`verify-email-code.ts:34-37` reads, compares, then increments, with nothing serializing the three.
Concurrent verifies all read `attempts` before any increment commits, so roughly a connection pool's
worth of guesses are tested where five should be. Bounded today by the per-IP throttle that
[SEC-05](#sec-05) removes. Fix: make the counter the gate with a conditional `updateMany`.

### SEC-29
`prisma-document.repository.ts:635` and `prisma-file-ref.repository.ts:172` build
`f.path LIKE ${folder} || '/%'` from `?path=`, which `RelativePath.tryParse` does not strip of `%`,
`_` or `\`. `?path=%25` matches every path in the library and desynchronizes the companion
`substring` offset. **Not** an access-control bypass — the library visibility check has already run
and everything returned is reachable by clicking — but it is a correctness bug plus an
index-defeating sequential scan usable as amplification. Fix: escape the metacharacters, or replace
the `LIKE` with an index-friendly prefix range.

### SEC-30
`read-upload-body.ts:58-60` strips the path with `/^.*[\\/]/`, and JS `.` does not match `\n`, so a
percent-encoded newline in `X-Legere-Filename` truncates the strip: `%0A..%2F..%2Fx.evil` yields
`"\n../../x.evil"`. **No key traversal is achievable** — the extension can never contain a dot, and
the key prefix is fixed — but the name is handed to Stirling as a multipart filename and lands in
document titles. Fix: strip control characters before splitting.

### SEC-31
`fs-library-reader.ts:147-154` implements a `realpath` containment check whose comment says it exists
for library creation — and `grep` finds **only the definition**. `CreateLibrary` uses `isDirectory`,
a lexical check plus `lstat`, which refuses to follow only the *final* component. If
`LIBRARY_ROOT/incoming` is a symlink to `/etc`, then `rootPath = "incoming/ssl"` passes both checks
and the walker ingests that tree. Admin-only and needs write access to a read-only-mounted volume,
hence Low. Fix: call the function that already exists.

### SEC-32
`server/main.ts:52` exempts `POST /documents` from the body parsers but not
`POST /documents/:id/files`, which reads its body the same raw way. Attaching a file whose
`Content-Type` is `application/json` therefore drains the stream and answers "the uploaded file is
empty" — or, over 1 MiB, with body-parser's own error, exactly the failure the comment says the
bypass exists to prevent. Uploading the same file as a *new* document works, so the asymmetry is
invisible until a user hits it.

### SEC-33
`stirling-pdf-toolbox.ts:258` — `/^\s*\|[\s:|-]+\|?\s*$/` has three overlapping quantifiers on `\s`.
Measured O(n²): 16 000 leading spaces → 161 ms; a 1 MB single line ≈ ten minutes of pinned CPU in the
Markdown worker. Input is a line of Markdown derived from an attacker's PDF. Fix: trim first, or bail
above a length.

### SEC-34
No security event logging exists: nothing records a successful or failed login, a lockout, an invite
issued or accepted, a password reset, a role change, an API-token creation, or an admin reading
`/api/admin/instance`. The document event journal covers documents, not accounts. After any incident
there is no record of who authenticated, from where, or when privileges changed.

### SEC-35
Sessions carry a 30-day absolute TTL set once, with no idle timeout, no rotation, and no way for a
user to list or revoke their own sessions (contrast API tokens, which they can). There is also **no
authenticated password-change endpoint** — a user who believes their password is compromised must ask
an admin for a reset link. `08 §8.1.7` rules out self-service *recovery*; authenticated rotation is a
different thing and is simply absent. `COOKIE_DOMAIN`, when set, hands `sid` to every sibling
subdomain, which `08 §8.2` does not flag as a risk. All of this needs a `08` change before code.

### SEC-36
`GET /api/health` is unauthenticated and deliberately outside the throttler, and runs `SELECT 1` plus
a pg-boss state read per call. Disclosure is minimal; the cost is not. Fix: cache for a second, or a
generous dedicated throttle a 5-second probe will never reach.

### SEC-37
Neither `server.disable('x-powered-by')` nor `poweredByHeader: false` is set; both layers advertise
themselves. Fingerprinting only, one line each.

### SEC-38
Invite and reset links put a single-use account-takeover credential in a path segment
(`manage-invites.ts:43`, `manage-password-resets.ts:41`), so it reaches browser history, proxy access
logs and the `Referer` of every subresource. Two things keep it contained and **both are accidental**:
those pages currently load no third-party subresource (fonts are self-hosted at build time), and the
browser default `strict-origin-when-cross-origin` is doing the work of the `Referrer-Policy` header
the app does not send. The Turnstile placeholder on the login form is where a third-party script
would first appear.

### SEC-39
The canonical PDF is embedded via `<object>` at `document-viewer-screen.tsx:385-397`, and the route
redirects to a presigned URL — so a malicious PDF exploiting a viewer bug executes in the **storage**
origin, where there is no session cookie. That is the right design, and it is the only reason
[SEC-03](#sec-03) is not automatically critical. It depends entirely on an invariant nothing asserts:
an operator who puts MinIO behind the same domain converts it into app-origin XSS. Fix: assert
`new URL(S3_PUBLIC_ENDPOINT).origin !== new URL(APP_BASE_URL).origin` at config load.

### SEC-40
`GET /api/people`, `/api/subjects` and `/api/subject-kinds` return the entire instance catalogue with
a **global** `documentCount` to any signed-in user, and those rows are populated by the analysis step
reading document text — including `RESTRICTED` libraries and other users' private uploads. A `USER`
with no HR grant still reads "Ivanov Ivan — 14 documents". The drill-down is correctly filtered, and
this matches `07 §7.3` — flagged because "the catalogue is global" and "names mined from documents
you may not read are global" are not obviously the same decision.

### SEC-41
`canEditDocumentMeta` treats any reader of a library document as an editor, so a user holding grants
on both library A and restricted library B can `combine` a B document into an A document; the
rebuilt canonical and Markdown then contain B's pages and are readable by everyone who can see A.
Byte access is still denied. `08 §8.5` reads as a statement about deduplicated identical bytes, not a
user-initiated merge — worth an explicit decision either way.

### SEC-42
`08 §8.2a` claims read-only enforcement happens twice — the middleware *and* the guard. `SessionGuard`
does no method check; the middleware is the only layer. Verified unbypassable today (the `/api`
dispatcher is case-sensitive and terminal, so `/API/…` never reaches Nest), but the documented second
layer does not exist. Three lines in the guard make the doc true.

### SEC-43
`Dockerfile:26` runs `npx prisma migrate deploy` at container start: `npx` would fetch from the
registry if local resolution ever failed, a second replica blocks on the advisory lock with no
rollback path, and the app then connects with the same role that just performed DDL — so any SQL
injection or process compromise gets `DROP TABLE`, not just `SELECT`. Fix: a one-shot migration
service with a privileged role, and a runtime role restricted to DML.

### SEC-44
`pg-boss-queue-monitor.ts:70` does `new Date(cursor)` on a `z.string().min(1)`, so
`?cursor=x` answers 500 instead of 422. Admin-only, no data impact.

### SEC-45
Every box in the security checklist of [`08 §8.6`](../08-auth-and-authorization.md#86-security-checklist)
is unticked. It was written as an intent and never verified — and this audit found that at least two
of its lines ("single-use invite links", "codes and tickets are never logged") are **false** in the
current tree. The checklist needs to become a mapped, tested claim like
[`scenario-coverage.md`](./scenario-coverage.md), or it is decoration.

---

## Verified safe

Recorded so the next audit need not re-derive it, and so a regression is visible as a change.

**Injection.** No SQL injection: every raw query uses tagged templates with bound parameters
(verified across `prisma-document`, `prisma-file-ref`, `prisma-grouping-candidates`,
`prisma-document-chunk`, `prisma-scan-run`, `prisma-library`, `prisma-user`, `prisma-db-health-checker`,
`pg-boss-queue-monitor`); `Prisma.raw` appears nowhere; no dynamic column names; `LIMIT`/`OFFSET` are
bound. No `child_process`, `exec`, `spawn`, `eval`, `new Function`, `vm`, or dynamic import of user
paths anywhere in `src/`. No regex is built from user input.

**Path handling.** Two independent guards: `RelativePath.parse` rejects NUL bytes, drive letters,
UNC and `..`; `resolveInsideRoot` re-verifies with `path.relative` after `resolve`. Symlinks are
never followed during the walk (`lstat` throughout), non-regular files and dotfiles are skipped. The
only gap is the intermediate-symlink case of [SEC-31](#sec-31).

**Authorization.** No unauthenticated route, no admin route missing `RolesGuard`, and no
list-filtered-but-get-by-id-unfiltered IDOR. Read access is expressed once as a SQL predicate rather
than re-derived per route; `DocumentAccessGuard` covers **all** of `:id`, `/markdown`, `/events`,
`/files`, `/files/:fileId`, `/files/:fileId/content`, `/crop-suggestion`, `/preview`, `/thumb`,
`/canonical` and `/combine` — including the signed-URL endpoints, which is where this bug normally
lives. Search applies the predicate *inside* the query, so `LIMIT` counts readable rows rather than
post-filtering. Soft-deleted rows are unreadable and unactionable everywhere checked. Zod strips
unknown keys, so there is no mass-assignment path: no route trusts a client-supplied role, owner or
visibility. A full route→guard inventory was produced during the audit.

**Credentials.** One audited primitive behind every bearer secret: `randomBytes(32).toString('base64url')`,
stored as SHA-256, unique-indexed so lookup is an index hit rather than a comparison. Email codes use
`randomInt` and HMAC-SHA256 with `timingSafeEqual`. Argon2id at the OWASP parameters; a malformed
hash returns `false` rather than throwing, so the login response stays uniform. An unknown address
still spends a real Argon2 verify against a memoized dummy, and the failure counter is bumped
identically on both branches, so neither the status code nor the timing nor the 429 boundary is an
enumeration oracle. Password hashes are absent from every DTO.

**Sessions.** Login always mints a new session, so fixation is not possible. Every request re-reads
the session, its revocation and expiry, and the user's existence and active state, with nothing
cached — so revocation and deactivation propagate on the very next request. Logout revokes
server-side and clears the cookie with the same attribute set. A password reset revokes every session
before the new one is issued. Cookie flags match `08 §8.2` exactly, with `Secure` derived from
`APP_BASE_URL` rather than `NODE_ENV` for the documented reason.

**Onboarding.** A `pg_advisory_xact_lock` plus a re-count inside the transaction, backed by the
partial unique index on active emails: two racing onboardings produce exactly one admin, and
deactivating everyone does not reopen it.

**Read-only API tokens.** Refused before routing on any unsafe method without a database lookup. No
method-override middleware exists; header casing is normalized; `/API/…` is handed to Next rather
than reaching a route; a request carrying both a cookie and a bearer authenticates as the *token*,
the weaker credential. A token cannot beget or revoke a token.

**Client.** Zero `dangerouslySetInnerHTML`, `innerHTML`, `document.write`, `eval` or `new Function`
in the entire tree. Markdown has exactly one render site and it applies `rehypeSanitize`; there is no
second forgotten screen, and `rehype-raw` appears nowhere. The sanitize schema strips `script`,
`style`, `iframe`, `object`, every `on*` handler, and `javascript:`/`data:` protocols. The
`ts_headline` markup that Postgres returns is **split and re-emitted as React elements**, not
injected as HTML — the classic bug here is genuinely absent, and there is a test asserting it. No
user-controlled URL ever reaches an `href` or `src`. No `localStorage`, `sessionStorage` or
`document.cookie` use; no secret reaches the client bundle; the RSC payload carries a Zod-parsed DTO
and nothing more. Error messages are mapped from codes, never reflected from the server. `next-intl`
is not affected by its middleware open-redirect advisory, because this app resolves locale per
request instead.

**Outbound calls.** No SSRF: every base URL comes from the validated env schema, Turnstile's is a
module constant, and no request-derived or database-stored host reaches a `fetch`. Invite and reset
links are built from `APP_BASE_URL`, never from a `Host` header, so host-header injection into a
token link is not possible. Multipart filenames are escaped by undici per spec.

**Storage.** Keys are UUID-derived, the bucket is private, presigned URLs are issued only after the
access check, and the default TTL is 300 s. The maintenance sweep matches strict UUID keys only and
cannot be tricked into deleting originals.

**Secret hygiene.** `.env` is gitignored and dockerignored and absent from git history; the runtime
image copies an explicit allow-list, so no source, no `.git` and no `.env` ship in it; the library
volume is mounted `:ro`; no docker socket is mounted anywhere; `deploy/init.sh` generates secrets
with `openssl rand`, writes `chmod 600`, and refuses to overwrite an existing `.env`. Error responses
leak nothing — unknown exceptions become a bare `500 INTERNAL` with the stack logged server-side
only.
