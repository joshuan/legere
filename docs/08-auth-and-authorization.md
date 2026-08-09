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
  optionally an email hint. They get a **single-use link** `APP_BASE_URL/invite/<token>` (an opaque
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
2. **Code check.** `POST /api/auth/register/verify { email, code }` — constant-time `codeHash`
   comparison; `attempts > 5` → the record is burned (`429 EMAIL_CODE_TOO_MANY_ATTEMPTS`); success →
   a single-use `registrationTicket` (opaque, hash in the DB, TTL 15 min).
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
user's sessions. Entities — [`03 §3.3.5`](./03-domain-model.md#335-passwordreset); endpoints —
[`07 §7.3`](./07-api-specification.md#73-endpoints).

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
  next to each other on `/settings` precisely so both can be dealt with in one visit.

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
- **Lifetime.** Expiry is mandatory (`API_TOKEN_TTL_DAYS`, default 90, max 365): a token nobody can
  remember issuing should stop working by itself. `lastUsedAt` is written at most once a minute, so
  the list can answer "is this one still in use?" without a write per request.
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
- **Rate limiting:** layer 1 — per-IP in-memory (`@nestjs/throttler`) on `/api/auth/*` and
  `/api/invites/*` (incl. protection against Argon2 flooding); layer 2 — per-email: `register/start`
  ≤1 code/60 s and ≤5/day; `register/verify` ≤5 wrong attempts → the record is burned; `login` — an
  exponential backoff on **failures**, specified below. Exceeding → `429 RATE_LIMITED`; all errors
  are generic.
- **CAPTCHA:** Cloudflare Turnstile on login and register/start; a `CaptchaVerifier` port; keys not set
  (dev) → no-op.

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

- [ ] No open registration: one-time first-admin onboarding + single-use invite links
      (tokenHash, TTL, revocation).
- [ ] Registration — 3 steps with an email code (HMAC hash, TTL 10 min, ≤5 attempts); the `User` is
      created only at step 3 via a single-use ticket.
- [ ] Login: a single `INVALID_CREDENTIALS` + dummy verify; Argon2id; no JWT.
- [ ] The login backoff never locks an account out: the password is verified before the streak is
      read, a correct one signs in and clears it, and a failure against an unknown address is
      refused with the same code at the same attempt as one against an address that exists (§8.4.1a).
- [ ] Session: an opaque token stored as a hash, new per login, revoked on logout; cookie
      httpOnly/SameSite=Lax/Secure(prod).
- [ ] A user can list and end their own sessions, and change their own password with the current one
      — which ends every other session of theirs and keeps the one that asked (§8.1.6a, §8.2).
- [ ] Mutations — fail-closed `csrfOriginCheck`; per-IP + per-email rate limiting; CAPTCHA on
      login/start.
- [ ] API tokens: hashed at rest, shown once, mandatory expiry, revoked with the owner; a mutating
      request carrying one is refused before routing (§8.2a).
- [ ] `passwordHash`/`tokenHash`/codes/tickets and email bodies are never serialized or logged —
      including by the request log, which writes the shape of a route and not the token in it, drops
      the query string, and removes the filename headers ([`06 §6.7`](./06-backend-architecture.md#67-logging));
      including when no mail server is configured, where the letter is recorded as its recipient and
      subject and its body is dropped (§8.1.8).
- [ ] Every protected route — `SessionGuard` (+ `RolesGuard`/`DocumentAccessGuard`); file endpoints —
      under the same authorization; the S3 bucket is private, signed URLs with a short TTL only.
- [ ] Libraries are mounted `:ro`; paths validated against the root (no path traversal/symlinks out).
- [ ] The last active admin is protected (`LAST_ADMIN`).
- [ ] SMTP credentials from a secret manager; the FROM domain with SPF/DKIM.

## 8.7. Open questions

None. Previously open items — resolved:

1. **Admin-initiated password reset** — yes, specified in §8.1.6.
2. **Default library visibility** — `RESTRICTED` (fail-closed), explicit assignment
   ([`03 §3.3.6`](./03-domain-model.md#336-library)).
3. **A third "view-only" role** — no; `ADMIN`/`USER` are sufficient for the MVP.
