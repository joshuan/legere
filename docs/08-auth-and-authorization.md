# 08. Authentication and Authorization

The model: email+password, email verification by code, server-side sessions, **closed registration**
(the instance is private: first admin + invite links) and **ADMIN/USER roles** with access via library
visibility and sharing.

- **Authn:** login with **email + password**; an account is created only with **email verification**
  (a code from a letter). Server-side sessions. No external OAuth providers.
- **Authz:** role (`ADMIN`/`USER`) + library visibility + explicit sharing of folders/collections.

## 8.1. How accounts come to exist

There is **no** open registration. An account appears in two ways:

### 8.1.1. First-administrator onboarding
If the DB has no active users, the application shows an initial-setup screen: the 3-step registration
(§8.1.3) — the created user gets the `ADMIN` role. Once the first user exists, the onboarding route
permanently answers 404/redirect (a race between two onboardings is resolved by the uniqueness of the
"first" inside a transaction).

### 8.1.2. Admin invite
- An admin creates a `UserInvite` in the admin panel: the future user's role (`USER`/`ADMIN`),
  optionally an email hint. 🔒 The hint is **binding where it is given**: a registration started
  with that link for any other address is refused. It stays optional — an invite without one is an
  invitation to whoever holds the link — but an invite that names somebody is an invitation to them,
  not a licence to send this instance's letters wherever the holder likes. They get a **single-use link** `APP_BASE_URL/invite/<token>` (an opaque
  token; only its `tokenHash` is stored in the DB; TTL 7 days by default; revocable).
- The invitee opens the link → goes through the 3-step registration (§8.1.3) → the account is created
  with the role from the invite, the invite is marked used (`acceptedById/acceptedAt`).
- Token properties: high-entropy, single-use, stored only as a hash, with a TTL, revocable; it is a
  bearer secret — never logged. 🔒 It travels in a path segment, which is the one place a URL is
  written down by default, so the request serializer logs the *shape* of a route and never its
  values ([`06 §6.7`](./06-backend-architecture.md#67-logging)): `GET /api/invites/:x`. The same
  holds for the reset link of §8.1.6.

### 8.1.3. The three account-setup steps (shared by onboarding, invites, and password resets)
A `User` is not created until email ownership is proven and a password is set. The intermediate state
lives in the `EmailVerification` table, not in `users`.

1. **Code request.** `POST /api/auth/register/start { email, inviteToken?, captchaToken? }` — email
   normalization (trim+lower), CAPTCHA (§8.4.2), rate limiting (§8.4.1). An active `EmailVerification`
   record is created/replaced: a 6-digit code, `codeHash = HMAC-SHA256(secret, code)`,
   `expiresAt = now + 10 min`, `attempts = 0`. The code is sent by email (SMTP, the `EmailSender`
   port). The response is always `200` (anti-enumeration); if the email is already taken, the letter
   says "you already have an account".
2. **Code check.** `POST /api/auth/register/verify { email, code, inviteToken?, resetToken? }` —
   constant-time `codeHash` comparison; `attempts > 5` → the record is burned
   (`429 EMAIL_CODE_TOO_MANY_ATTEMPTS`); success → a single-use `registrationTicket` (opaque, hash in
   the DB, TTL 15 min).

   🔒 **An attempt is charged only to a caller who proves they hold the link the series was made
   from.** The series remembers which invite or reset started it
   ([`03 §3.3.3`](./03-domain-model.md#333-emailverification)), and step 2 must echo the same
   `inviteToken`/`resetToken` step 1 accepted. A caller who does not is answered
   `400 EMAIL_CODE_INVALID` — the same answer a wrong code gets, so nothing is learned — **before the
   attempt counter is touched**, so nothing is spent. Where an address has an active reset *and* an
   active registration series, the reset is still tried first (§8.4); the series a code is measured
   against is the first one the caller can prove is theirs.

   The one series with no link to hold is the onboarding one, and its attempts are charged to
   whoever presents a code. Nothing is lost by that: while onboarding is open anybody who can reach
   the instance can finish it and become its first administrator (§8.1.1), so that code is not
   standing in front of an account.

   **Why this shape.** §8.4.1a's rule for the login backoff — *a backoff may slow an attacker down,
   and it may never stand between an account and its own password* — has a verification-code twin,
   and it used to be broken here. The series was found by address alone and the attempt was charged
   before the code was compared, so anyone who knew an address could spend its five guesses and burn
   the row: the owner's own correct code then answered `EMAIL_CODE_INVALID`, their resend was burned
   again, and after five letters the daily cap of §8.4 took away the only recovery path this product
   has (§8.1.7) for a day (SEC-57). Two other shapes were on the table and neither satisfies the
   rule. Capping per (series, IP) with a larger per-series ceiling only raises the price of the
   denial — a second source address buys the attacker the ceiling back, and the burn still stands
   between an account and its own password. Re-issuing on exhaustion rather than deleting turns the
   endpoint into a mailer aimed at the victim, and the code they had already typed stops working,
   which is the same denial with the operator's return address on it. Proof of possession is the only
   one of the three that removes the attacker instead of slowing them, and it costs the brute-force
   cap nothing: five wrong codes from the holder still burn the series.
3. **Password setup.** `POST /api/auth/register/complete { ticket, password }` — password validation
   (8–128 + a denylist of common passwords), `User` creation (Argon2id hash; `displayName` from the
   local part of the email; language from `Accept-Language`), `Session` creation, the `sid` cookie.

### 8.1.4. Login
`POST /api/auth/login { email, password, captchaToken? }` — login only, never creates an account.
"No such user" and "wrong password" → the same `401 INVALID_CREDENTIALS` + a dummy verify
(anti-enumeration/anti-timing). Success → a **new** `Session` (anti-fixation), the `sid` cookie.

### 8.1.5. Password hashing
Argon2id only (the `argon2` package; OWASP parameters: `m=19456 KiB, t=2, p=1`), a PHC string in
`users.password_hash`; never serialized outward. Behind a `PasswordHasher` port
(domain/application do not depend on `argon2`).

### 8.1.6. Password reset (admin-initiated)
There is no self-service "forgot password". An admin generates a **single-use reset link** from the
admin panel (`PasswordReset`: opaque token, `tokenHash` in the DB, TTL 24 h, revocable) and hands it
to the user out of band. The user opens the link and passes the same 3-step flow (§8.1.3) with
`purpose = PASSWORD_RESET`: code to their email → new password. Completion revokes **all** of the
user's sessions **and all of their API tokens**. Entities —
[`03 §3.3.5`](./03-domain-model.md#335-passwordreset); endpoints —
[`07 §7.3`](./07-api-specification.md#73-endpoints).

🔒 **The tokens go with the sessions, because this is the recovery.** An admin issues a reset link
for one reason: somebody believes the account is in somebody else's hands. A stranger who held a
session for a minute could mint a read-only API token from it (§8.2a) — one request, no admin
involved, good for up to a year — and until this rule was written the documented remediation ended
every session, changed the password, and left that credential reading the archive (SEC-65). The
asymmetry with the self-service rotation of §8.1.6a is deliberate and is the point: a person
changing their own password is tidying up and should not lose their backup script, while an admin
handing over a reset link is cleaning up after a compromise and must not leave a credential behind.

### 8.1.6a. Password change (self-service, authenticated)
`POST /api/me/password { currentPassword, newPassword }` — a signed-in user replaces their own
password without asking anybody. This is a **rotation**, not the recovery §8.1.7 rules out: the
caller is already authenticated and proves it a second time with the password being replaced, so
nothing here is a way in for somebody who is locked out.

- The current password is verified with the same `PasswordHasher` as login; wrong → `401
  INVALID_CREDENTIALS`. There is no enumeration question to answer — who is asking was settled by
  the session guard — so the answer can be plain.
- The new password passes the rule of §8.1.3 step 3 (8–128 + the denylist) and must differ from the
  current one.
- 🔒 **Every other session of that user is revoked**, and the one making the request is kept. Someone
  rotating a password because they believe it leaked has to be able to end the sessions the leak
  bought; the session they are sitting in is the one they can vouch for, and signing them out of it
  would make the safe action the annoying one. The write and the revocation share a transaction: a
  password changed without them would leave stolen sessions alive under a password their owner
  believes they have already replaced.
- The response carries how many other sessions ended, so the UI can say it.
- Reachable with a **session only**. It is a mutation, so a bearer credential is refused before
  routing (§8.2a) — a read-only token has no business rotating the password behind it.
- API tokens are deliberately **not** revoked by a password change: a token is a separate credential
  with its own list and its own revocation (§8.2a), and killing a backup script because somebody
  changed their password is a surprise nobody asked for. The sessions card and the tokens card sit
  next to each other on `/settings` precisely so both can be dealt with in one visit. An
  admin-issued **reset** does revoke them (§8.1.6) — a rotation is housekeeping, a recovery is not.
- Throttled at 5 requests per 60 s per caller (§8.4). The route verifies an Argon2 hash before it
  can fail, and that verification queues at the same concurrency gate login uses; a budget in front
  of it is what keeps the gate serving logins rather than one account's replay (SEC-54).

### 8.1.7. Not in the MVP
No self-service password **recovery** — a person who cannot sign in is told to contact their
administrator, who issues the single-use link of §8.1.6. That is about *recovery*, and it does not
rule out rotation: a user who **can** sign in changes their own password under §8.1.6a, which asks
for something only they know and therefore needs nobody's help.

Also not in the MVP: no email change, no MFA. Email verification always exists (protection against
address squatting).

### 8.1.8. Local development
SMTP not configured → `LogEmailSender`, which records that a letter was not sent — its recipient and
its subject — and never what was in it. 🔒 Every body this application composes carries the six-digit
code of §8.1.3, and a log is read by more people than a database is, so there is no level at which
printing it is safe; the code exists in the letter and nowhere else. Going through registration on a
laptop therefore needs somewhere for mail to land: a local catcher costs one command
([`12 §12.5`](./12-build-config-run.md#125-local-development)). A production instance refuses to
start with no `SMTP_HOST` at all ([`12 §12.4a`](./12-build-config-run.md#124a-what-production-refuses-to-start-with)).

CAPTCHA keys not set → no-op. The seed creates an admin and a user with the password `password`,
which is how a developer signs in without mail at all.

## 8.2. Server-side sessions

- Token `t = crypto.randomBytes(32).toString('base64url')`; the DB stores `tokenHash = sha256(t)`,
  `userId`, `expiresAt = now + SESSION_TTL` (30 days), `userAgent`. Always a **new** session per login.
- `SessionGuard` on every request: the `sid` cookie → hash → an active session →
  `request.currentUser`.
- `POST /api/auth/logout` → `revokedAt`, cookie cleared. An admin can revoke a user's sessions.
- The `sid` cookie: HttpOnly; **Secure whenever `APP_BASE_URL` is `https://`**; SameSite=Lax; Path=/;
  Max-Age = SESSION_TTL; Domain from `COOKIE_DOMAIN`.
  The attribute follows the address the app is served under rather than `NODE_ENV`: browsers drop a
  Secure cookie arriving over plain HTTP, so tying it to the mode would leave every self-hosted
  instance on `http://<lan-ip>` unable to hold a session at all — the operator's choice to run
  without TLS should cost them encryption, not the ability to log in. Any deployment reachable over
  HTTPS gets the attribute, in production or not.

**A user's own sessions.** `GET /api/me/sessions` lists the caller's **live** sessions — when each
started, the user agent it carries, and which one is asking — and `DELETE /api/me/sessions/:id` ends
any of them ([`07 §7.3`](./07-api-specification.md#73-endpoints)). Revoked and expired rows are left
out: unlike an API token, whose history answers "what did I hand out", a dead session is a fact about
a browser that has already stopped mattering. Revoking the current one is allowed and clears the
cookie with it — signing this device out from the list is what the list is for. Somebody else's
session answers `404 SESSION_NOT_FOUND`, not `403`: that it exists at all is none of their business.
Both routes need a **session**, not a token: "which of these is you" is a question a bearer
credential has no answer to, so it is refused with `403 FORBIDDEN` rather than crashing. An admin
could already end anybody's sessions (§8.3); this is the same power in the hands of the person the
sessions belong to, because a credential you cannot see is a credential you cannot revoke.

**Lifetime: 30 days absolute, and no idle timeout.** A session dies when it is revoked, when its
owner is deactivated, or when the 30 days set at login run out — not because nobody used it for a
while. An idle timeout was considered and **not** adopted: this is a self-hosted archive somebody
consults every few weeks, an idle clock would sign them out between visits for a threat (a browser
left open on a shared machine) that the revocation list above already answers deliberately. A role
change does not re-issue the session either — the role is re-read from the user on every request
(§8.2a makes the same promise for tokens), so a demotion takes effect immediately without touching
the session at all.

🔒 **What `COOKIE_DOMAIN` costs.** Unset (the default), `sid` is a host-only cookie: only the exact
host the app is served from ever receives it. Set to `example.com`, the browser sends it to
`example.com` **and every subdomain of it** — `wiki.example.com`, `grafana.example.com`, whatever
else the operator runs there, including anything they do not control. One XSS or one hostile app on
any sibling subdomain then reads a session for this instance; the same applies to a subdomain
somebody else can take over. Set it only when Legere genuinely spans several hostnames under one
domain, and treat every sibling as being inside the trust boundary when you do
([`12 §12.4`](./12-build-config-run.md)).

## 8.2a. API tokens (read-only)

A browser is not the only thing that has a reason to read an archive: a backup script, a scheduled
export, an assistant answering questions about what is filed here. Those callers get a **read-only
API token** ([`03 §3.3.22`](./03-domain-model.md#3322-apitoken)) instead of a password, so that a
credential which leaks costs its owner nothing but a revocation and can never change a document.

- **Issuing.** A signed-in user creates their own tokens on `/settings` — no admin involvement,
  because the token grants strictly less than the session used to create it. The request names the
  token and may set a lifetime; the response carries the plaintext **once**
  ([`07 §7.3`](./07-api-specification.md#73-endpoints)).
- **Shape.** `legere_` + `crypto.randomBytes(32).toString('base64url')`. The prefix is not a secret
  and does not authenticate anything; it exists so the string is recognisable to a human reading a
  config file and to a secret scanner reading a repository. Only `sha256(token)` reaches the
  database, as with every other bearer secret in this system (§8.2).
- **Presenting.** `Authorization: Bearer <token>` on `/api/*`. There is no cookie and no CSRF
  question: nothing a browser sends automatically can carry this header.
- **Read-only, enforced twice.** A mutating method (anything but `GET`/`HEAD`/`OPTIONS`) carrying an
  `Authorization: Bearer` header on `/api` is refused with `403 READ_ONLY_TOKEN` by a middleware
  standing beside `csrfOriginCheck` — before routing, without looking the token up, so a route that
  forgot its guard is still covered. `SessionGuard` behind it refuses to resolve a bearer credential
  on an unsafe method at all, and refuses it *before* the lookup, so neither layer turns an honest
  refusal into "invalid token". Fail-closed, like the origin check it stands next to, and proven by
  a test that stands the guard up with the middleware removed.
- **Authorization.** The token resolves to its owner and inherits **their** role and visibility: an
  admin's token reads the admin endpoints, a user's token reads what that user can read. Deactivating
  the owner, or revoking the token, ends it immediately — every request re-reads both.
- 🔒 **What ends every one of them at once.** Deactivating the account (`03 §3.3.22`) and completing
  an **admin-issued password reset** (§8.1.6) both revoke the owner's whole list, inside the same
  transaction as the sessions they stand beside. A self-service password change does not (§8.1.6a).
  Recovery takes every credential; rotation takes none of them.
- **Lifetime.** Expiry is mandatory (`API_TOKEN_TTL_DAYS`, default 90, max 365): a token nobody can
  remember issuing should stop working by itself. `lastUsedAt` is written at most once a minute, so
  the list can answer "is this one still in use?" without a write per request.
- 🔒 **One route where a POST is a read** (`07 §7.3a`, ADR-024). MCP speaks JSON-RPC over a single
  `POST /api/mcp`, so the rule above — a bearer on anything but `GET`/`HEAD`/`OPTIONS` is refused
  before routing — would refuse the whole protocol. The exception is **one path, declared once**
  (`isReadOnlyPostRoute`) and consulted by all three of the places that would otherwise refuse it:
  the origin check, the read-only middleware and `SessionGuard`. 🔒 The exemption matches paths the
  way the router resolves them — lower-cased, trailing slash trimmed — because Express routes
  case-insensitively and a matcher stricter than its router is a rule with a spelling that escapes
  it (SEC-87); and it covers the API path alone, never the bare `/mcp` that belongs to Next
  (SEC-88). What makes it safe is not the
  narrowness but what is on the other side: **the route accepts no cookie**, so it has no
  credential a browser sends by itself and CSRF has nothing to act on — the check of §8.4 is not
  weakened, it is inapplicable. And the tools it dispatches to are a closed list over read use
  cases, so "read-only" there is a property of the registry rather than a promise about whatever is
  mounted next.
- **Not in this feature:** scopes narrower than "read what the owner reads", per-token IP limits,
  and machine accounts without a human owner. Each is a real thing to want; none is needed to let a
  script read an archive, and none can be added silently — a token's authority is exactly its
  owner's, and that is a sentence users can hold in their heads.

## 8.3. Roles

| Capability | USER | ADMIN |
|------------|------|-------|
| Viewing/searching documents of accessible libraries, folders/collections, sharing; composing documents out of files | ✅ | ✅ |
| Library management (creation, paths, intervals, visibility, rescan) | — | ✅ |
| User invites, role changes, deactivation, session revocation | — | ✅ |
| Document type reference list | — | ✅ |
| Queue monitoring, retrying FAILED jobs, scan journals | — | ✅ |
| Document deletion (soft delete) | — | ✅ |

**Invariants:** the **last active admin** cannot be deactivated/demoted (`409 LAST_ADMIN`).
The role is stored on the user (`User.role`); checked by `RolesGuard` on top of `SessionGuard`.

## 8.4. CSRF, rate limiting, CAPTCHA

- **CSRF:** the SameSite=Lax cookie + `csrfOriginCheck` on **all mutations** (incl. login/register) —
  `Origin`/`Referer` compared against `APP_BASE_URL`, **fail-closed** (absent/mismatched → 403). The
  check is mounted above the `/api` dispatcher, not on `/api`: which requests may change state is
  not a question of where a route happens to be mounted, and a Next route handler or server action
  added later would otherwise inherit the session cookie with no check at all.
- 🔒 **The per-address caps are per *purpose*.** A sign-up letter and a reset letter draw on separate
  daily allowances, and where an address has both an active registration and an active reset series,
  the **reset** is the one a code is checked against. Both follow from the same attack: an invite
  holder can start a registration for any address (§8.1.2 binds an invite to its `emailHint` where
  there is one, which closes most of it), and with one shared counter those letters would spend the
  allowance a password reset needs — and a stale registration series would swallow the attempts of
  the reset its owner actually asked for. A code is never compared while choosing between series:
  the attempt counter is the only gate, and a comparison in front of it would be a guess that was
  tested without being counted — and the series a caller is measured against is the first one they
  can prove they hold (§8.1.3 step 2).
- **Rate limiting:** layer 1 — in-memory budgets (`@nestjs/throttler`), four of them, each counted
  separately:

  | Budget | Where | Allowance |
  |---|---|---|
  | `auth` | `/api/auth/*`, `/api/invites/*`, `/api/password-resets/*` | 20 / 60 s |
  | `catalogue` | `POST /api/people`, `/api/subjects`, `/api/subject-kinds` | 30 / 60 s |
  | `password` | `POST /api/me/password` | 5 / 60 s |
  | `search` | `GET /api/search`, `POST /api/mcp` | 30 / 60 s |

  `auth` is the Argon2-flooding brake the login path leans on (§8.4.1a). `catalogue` is fast enough
  for a person correcting an archive and far too slow to fill by script a namespace every other user
  reads (SEC-56). 🔒 `password` exists because that route verifies an Argon2 hash before it can
  fail, and does it behind the same concurrency gate of two that login queues at: with no budget in
  front of it one signed-in account could fill that queue from a route no throttler covered, and
  nobody on the instance could sign in or finish registering (SEC-54). 🔒 `search` exists because
  every non-text search spends one outbound embeddings call on the operator's provider and takes a
  turn at the pipeline's own embeddings gate ([`05 §5.4b`](./05-library-and-processing.md)), so a
  read that costs money off-instance is metered like a write (SEC-74) — and `POST /api/mcp` carries
  the same search for an assistant (`07 §7.3a`).

  🔒 **A budget is counted against the caller, not the address they arrived from,** wherever the
  request has one: a signed-in caller — session or API token — is counted by their user id, and only
  an anonymous one by `req.ip`. The attacker of SEC-54 and SEC-74 is an account, and an account
  changes addresses far more easily than an address changes accounts; the anonymous routes keep the
  per-IP behaviour they always had.

  🔒 **And it is one allowance over the routes it names, not one per route.** The throttler's own
  key carries the controller and the handler, which would have made the first row of that table mean
  twenty per endpoint — the reading SEC-57 leaned on to poll `register/verify` twenty times a minute
  while spending nothing anywhere else. The budget's name and the caller are the whole key.

  layer 2 — per-email: `register/start` ≤1 code/60 s and ≤5/day; `register/verify` ≤5 wrong attempts
  → the record is burned; `login` — an exponential backoff on **failures**, specified below.
  Exceeding → `429 RATE_LIMITED`; all errors are generic.
- **CAPTCHA:** Cloudflare Turnstile on login and register/start, **both halves of it** — the widget
  renders on the client and the token it mints travels as `captchaToken`; the server checks it
  through a `CaptchaVerifier` port. 🔒 The halves are two switches and they have to be thrown
  together: the widget appears when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set, verification happens
  when `TURNSTILE_SECRET_KEY` is set, and a secret with no widget in front of it refuses **every**
  login and **every** registration on the instance — including the admin's, and including the
  password reset that runs through `register/start` — because nothing mints the token the server
  then demands. Neither key set (the shipped default, and dev) → no widget and a verifier that says
  yes. The site key is read by the client, so it is baked into the bundle at **build** time
  ([`12 §12.6`](./12-build-config-run.md#126-dockerfile-one-image)): an image built without it cannot
  grow a widget from a runtime variable, which is what `/admin/instance` says on that row
  ([`12 §12.4`](./12-build-config-run.md#124-envexample)).
  Until the token arrives the form does not submit, so a configured widget is a step in the flow
  rather than a rejection after the fact ([SEC-77](./tasks/security-audit-2026-08-second-pass.md#sec-77)).
- 🔒 **So setting `TURNSTILE_SECRET_KEY` is warned about at every start, unconditionally**, in the
  words of the paragraph above: verification is now on for every login and every registration, only
  a bundle built with the site key mints the token they must carry, and the operator is told to open
  the sign-in page and see a widget before they close the session. It is a **warning and not a
  refusal**, and that is a decision rather than a shortfall. A refusal would have to read the runtime
  environment for `NEXT_PUBLIC_TURNSTILE_SITE_KEY` — and an image built correctly from this
  repository carries that key inlined in its client bundle and *not* in its environment
  ([`12 §12.6`](./12-build-config-run.md#126-dockerfile-one-image)), so the check would refuse to
  start exactly the instance that had done it right. Reading the built bundle back at boot would make
  configuration depend on build output. The warning fires whenever the secret is set — including when
  the site key is *also* in the runtime environment, where it does nothing at all — because copying
  both keys into `.env` is the natural thing to do and is precisely the case that silences the
  `/admin/instance` row. A weak signal that is always true beats a strong one that is sometimes
  wrong; and the lockout it warns about is total and has no way back in through the UI.
  🔒 **And a widget whose script never arrives says so in words.** The other half of the same
  lockout: with the site key baked in but `challenges.cloudflare.com` out of reach — an air-gapped
  self-host, an extension, a `script-src` that has never heard of that origin — nothing mints a
  token and nothing reports it either, because `error-callback` belongs to a widget that was never
  rendered. Sign in would then be disabled for ever with an empty gap where the explanation should
  be. So the client gives the script a bounded time to load and treats the browser's own refusal of
  it as the same answer, and both draw a localized message naming the origin that must be reachable
  and saying that an administrator can rebuild without the site key. **The message is not a way
  past the check**: no token is minted, the button stays off, and a challenge that loaded and was
  failed is never submittable — a self-hosted instance being told why nobody can sign in is the
  whole of what this adds.

### 8.4.1a. The login backoff, and what it may never do

🔒 **The password is checked first; only a failure is delayed.** One login attempt runs in this
order: CAPTCHA → look the address up → verify a password hash → and *then*, on a failure only,
record the failure and read the backoff. Consecutive failures against one address are counted, and
from the fifth each further failure answers `429 RATE_LIMITED` for a window that starts at one
second and doubles per failure to a cap of fifteen minutes. A **correct** password signs in
whatever the streak says, and clears it.

This is the whole point, and it is a change from what this document used to specify. The backoff
used to be read *before* the password: five wrong guesses against an address, then one request every
fifteen minutes, and its rightful owner could never sign in again — knowing the correct password did
not help, because nothing looked at it. That made an email address a remote lockout weapon at about
96 requests a day per victim (SEC-12). The rule that replaces it: **a backoff may slow an attacker
down, and it may never stand between an account and its own password.**

What the inversion costs, and why it is affordable: an unauthenticated caller now spends one Argon2
verification per request, because the expensive operation moved in front of the cheap gate. That is
bounded on purpose — password hashing runs behind a concurrency gate of two (`ConcurrencyGate` in
`Argon2PasswordHasher`, which is the "protection against Argon2 flooding" the rate-limiting bullet
above names), so a login flood queues instead of holding every libuv thread, and the per-IP
throttler stands in front of the controller. The cost was already being paid
on the most common path anyway: every attempt against an address that exists always verified a hash.

🔒 **The refusal must stay indistinguishable.** Exactly one verification happens per attempt on every
path — an address nobody registered is verified against a dummy hash (§8.1.4) — and the streak is
never consulted before that verification, so a fast `429` and a slow `401` cannot be told apart by a
clock. Failures are recorded for unknown addresses too, so an address that does not exist reaches
the backoff on the same attempt and answers the same code as one that does. Neither the answer nor
its timing may be allowed to say whether an account exists.

### 8.4.1b. What the throttles forget when the process restarts

🔒 The login streaks (`InMemoryLoginAttempts`) and the per-address daily email cap
(`InMemoryEmailSendThrottle`) live **in the process**, so a restart clears both, and two instances
behind a load balancer would each keep their own. This is a **deliberate limitation**, recorded here
rather than left to be discovered:

- **Neither has a home in the schema** ([`04 §4.1`](./04-database-schema.md)): persisting them means
  a table, a migration, a write on every failed login and a sweep for old rows — real cost for a
  self-hosted instance that mostly has one process and one user.
- **What a restart costs is now small.** Since §8.4.1a the login streak can no longer lock anybody
  out; losing it hands an attacker a few free guesses, which the per-IP throttler and the Argon2
  gate still charge for. The 60-second floor between two verification codes is enforced from the
  `EmailVerification` row and therefore **survives** a restart; only the daily ceiling of five is
  lost, so a restart loosens the cap without removing the brake under it.
- **The remaining exposure** is an attacker who can make the process restart at will — a crash loop —
  who would then reset the daily email cap on demand. Anybody with that power has a denial of
  service already, which is the larger problem.

Persisting both is the right answer for a multi-instance deployment and stays on the table; it is a
forward-only migration plus a repository, and nothing in the ports has to change to allow it. The
per-IP throttler already documents the same per-instance limitation
([`12 §12.8`](./12-build-config-run.md)).

🔒 **What they may not do is grow.** Forgetting on a restart is a limitation; growing until the
restart is a bug, and all three of these structures had it.

- **The login streaks are swept and capped.** `InMemoryLoginAttempts` is keyed by whatever address a
  caller typed, and failures are recorded for addresses nobody owns on purpose (§8.4.1a) — so one
  well-behaved source IP, spending exactly the documented budget on 254-character addresses, used to
  buy the operator a few hundred megabytes a month that nothing ever returned (SEC-70). A streak
  means nothing once the fifteen-minute cap has elapsed since its last failure, so entries older than
  that are dropped on the way in, and a ceiling on the number of streaks evicts the coldest as a
  backstop. Neither can refuse anybody: dropping a streak only forgets a failure.
- **The daily email cap prunes on the same pass**, rather than only when the address it belongs to is
  touched again.
- **The per-IP counters live in this application's own throttler storage**, not the package's
  default one, for two reasons. The default keeps its decay timers in one bucket per throttler
  *name*, and cancels the whole bucket whenever any blocked key comes back — so one anonymous caller
  cycling "spend the budget, wait a minute, knock once" stopped the documented 20-per-60 s window
  from sliding for every other client on the instance (SEC-73). And it never deletes a key, so the
  map grew one entry per source address for the life of the process. Ours holds the timestamps of
  the hits inside the window instead, which makes the window slide exactly and needs no timers at
  all, and it drops a key once its window and its block have both elapsed, with a cap on the number
  of keys as a backstop.

## 8.5. Content access model

Principles (the exact entity model — in 03):

- **Library → visibility.** Each library has a visibility setting: "all users" or an explicit list. A
  document from a library is visible to whoever the library is visible to (a document whose files live
  in several libraries is visible given access to at least one).
  🔒 That sentence covers the case it was written for — the same bytes discovered on two volumes,
  where deduplication makes one document out of them — and it is also a **licence to bridge two
  libraries by hand**, deliberately. A user holding grants on an open library and a restricted one
  may combine a document from the second into a document from the first, and the rebuilt canonical
  PDF and Markdown then carry its pages to everyone who can see the first. This is allowed because
  the alternative is worse: composing a document out of files is the product's central act
  ([`05 §5.6`](./05-library-and-processing.md)), and a rule that let a person read two things and
  refused to let them put those two things together would be arbitrary from where they stand. The
  boundary that does hold is that they must already be able to read both — a combine grants its
  author nothing they did not have. Byte access is unaffected: a file whose only home is a library
  the reader cannot see still refuses to stream.
  🔒 **Composing is not one right but two** ([`03 §3.4a`](./03-domain-model.md)). Whoever may read a
  library document may **arrange** it — add a page, reorder, crop, turn, split, move pages out — for
  the reason they may correct its title. Whoever may read it may **not destroy** what it is made of:
  removing a page, replacing a file's bytes, and combining a document away are the creator's or an
  `ADMIN`'s, and a document a scan made has no creator. Deletion is `ADMIN`-only one route above
  (`DELETE /api/documents/:id`), and an operation that removes content is not less privileged for
  being spelled differently. 🔒 No composition, by anybody, may leave a document holding no library
  page when it had one and has no creator: that document would be readable to an `ADMIN` and to
  nobody else, and it is refused (`422 DOCUMENT_WOULD_HAVE_NO_READERS`) before it is written rather
  than discovered after.
- **Documents nobody found on a volume** — an upload, a split, a combine — belong to their creator;
  visible to them and to whoever they share with.
- **Sharing.** A user can make their folders/collections (and derived documents) shared: with specific
  users or with the whole instance. Sharing grants **read** access; structure editing — owner only.
- **Personal organization** (folders/collections, notes) is private by default.
- `ADMIN` sees everything (instance maintenance).
- 🔒 Resource missing/soft-deleted → `404 *_NOT_FOUND`; exists but no access → `403 FORBIDDEN`.
- 🔒 File access happens only after the same access check as the document's metadata: derived
  artifacts from the private S3 bucket are served via **short-lived signed URLs**, library sources —
  streamed through the application. There are no direct/unauthenticated file links; a signed URL is
  never published in the UI as a permanent one.
- 🔒 Access decides *whether* bytes are served; it does not decide what they are allowed to be. An
  original always comes back as something to save, never as something to render: its content type is
  normalized against a short allow-list — the canonical PDF, and images, SVG excluded — and anything
  else is `application/octet-stream`, with `Content-Disposition: attachment` and `nosniff`. The rule
  is applied when the object is written *and* signed into the presigned URL, so an object stored
  before the rule existed is still served under it. Without this, a `report.html` an ordinary user
  uploads is stored as `text/html` and executes in the storage origin when anyone opens it
  ([`09 §9.2`](./09-file-storage.md)).

Guards: `SessionGuard` (authn) → `RolesGuard` (admin routes) → `DocumentAccessGuard`
(resolves the document/library from path parameters + checks visibility/sharing).

## 8.6. Security checklist

🔒 **A box here is ticked because a test proves it, and for no other reason.** Every line is mapped to
the test that makes its claim in
[`tasks/scenario-coverage.md`](./tasks/scenario-coverage.md#the-security-checklist-of-08-86), by file
and by the `it(...)` string, so any line can be re-run rather than re-believed. A line no test covers
stays empty and says what is missing instead of quietly reading as done.

This is what the list was worth before: it was written as an intent, never verified, and the audit of
August 2026 found two of its lines **false** at the moment it read them — invite links were not
single-use ([SEC-04](./tasks/security-audit-2026-08.md#sec-04)) and invite and reset tokens were
written to the request log in plaintext ([SEC-10](./tasks/security-audit-2026-08.md#sec-10)). Both are
fixed; the habit that let them sit here unnoticed is what
[SEC-45](./tasks/security-audit-2026-08.md#sec-45) is about.

- [x] No open registration: one-time first-admin onboarding + single-use invite links
      (tokenHash, TTL, revocation).
- [x] Registration — 3 steps with an email code (HMAC hash, TTL 10 min, ≤5 attempts); the `User` is
      created only at step 3 via a single-use ticket. Those five attempts are spendable only by a
      caller who proves they hold the link the series came from, so knowing an address does not deny
      it its own recovery (§8.1.3 step 2).
- [x] Login: a single `INVALID_CREDENTIALS` + dummy verify; Argon2id; no JWT.
- [x] The login backoff never locks an account out: the password is verified before the streak is
      read, a correct one signs in and clears it, and a failure against an unknown address is
      refused with the same code at the same attempt as one against an address that exists (§8.4.1a).
- [x] Session: an opaque token stored as a hash, new per login, revoked on logout; cookie
      httpOnly/SameSite=Lax/Secure — the last one whenever `APP_BASE_URL` is `https://`, which is
      not the same as production and §8.2 says why.
- [x] A user can list and end their own sessions, and change their own password with the current one
      — which ends every other session of theirs and keeps the one that asked (§8.1.6a, §8.2).
- [x] Mutations — fail-closed `csrfOriginCheck`, above the dispatcher rather than on `/api` (§8.4);
      four named rate-limit budgets counted per caller (per IP where there is none) + per-email
      limits; CAPTCHA on login/start — the widget mints the token on the client and the server
      verifies it, so the control is whole where both keys are set and absent where neither is (§8.4).
- [x] API tokens: hashed at rest, shown once, mandatory expiry, revoked with the owner and with the
      admin-issued reset that takes the account back (§8.1.6); a mutating request carrying one is
      refused before routing (§8.2a).
- [x] `passwordHash`/`tokenHash`/codes/tickets and email bodies are never serialized or logged —
      including by the request log, which writes the shape of a route and not the token in it, drops
      the query string, removes the filename headers, and keeps a response to an allow-list of
      headers, so a download's presigned `Location` and its `Content-Disposition` are not written
      either ([`06 §6.7`](./06-backend-architecture.md#67-logging));
      including when no mail server is configured, where the letter is recorded as its recipient and
      subject and its body is dropped (§8.1.8).
- [x] Every protected route — `SessionGuard` (+ `RolesGuard`/`DocumentAccessGuard`); file endpoints —
      under the same authorization; the S3 bucket is private, signed URLs with a short TTL only.
      "Every" is read off the route table mechanically, not asserted route by route.
- [x] Library paths are validated against the root: no traversal, no symlink leaving the volume
      during a scan, and a root reached through an intermediate symlink is refused at creation.
- [ ] Libraries are mounted `:ro`. **Deployment, not code** — the other half of what used to be one
      line with the box above, separated because only one of the two is this side's to prove. The
      mount is a line in `deploy/docker-compose.yaml`
      ([`12 §12.7`](./12-build-config-run.md#127-deployment-deploy-shipped-with-the-repository)), and
      an instance whose operator mounted the volume read-write behaves identically as far as any test
      here can see. The application's own promise — it never opens a library file for writing
      ([`09 §9.1`](./09-file-storage.md)) — is a different thing from the kernel refusing the write.
- [x] The last active admin is protected (`LAST_ADMIN`).
- [ ] SMTP credentials from a secret manager; the `SMTP_FROM` domain with SPF/DKIM. **Deployment,
      not code**, and no test here can assert either: both are properties of the environment the
      operator builds. What actually ships is weaker than "a secret manager" and says so —
      `deploy/init.sh` generates the secrets and writes them into a `chmod 600` `.env`
      ([`12 §12.7`](./12-build-config-run.md#127-deployment-deploy-shipped-with-the-repository)) —
      and the SPF/DKIM requirement is a production note with the failure mode it causes
      ([`12 §12.8`](./12-build-config-run.md#128-production-notes)). Left unticked on purpose: an
      empty box that names the gap is worth more than a ticked one nobody checked.

## 8.7. Open questions

None. Previously open items — resolved:

1. **Admin-initiated password reset** — yes, specified in §8.1.6.
2. **Default library visibility** — `RESTRICTED` (fail-closed), explicit assignment
   ([`03 §3.3.6`](./03-domain-model.md#336-library)).
3. **A third "view-only" role** — no; `ADMIN`/`USER` are sufficient for the MVP.
