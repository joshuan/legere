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
  bearer secret — never logged.

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

### 8.1.7. Not in the MVP
No self-service password recovery ("Contact your administrator"), no email change, no MFA. Email
verification always exists (protection against address squatting).

### 8.1.8. Local development
SMTP not configured → `LogEmailSender` prints the code to the log. CAPTCHA keys not set → no-op. The
seed creates an admin and a user with the password `password`.

## 8.2. Server-side sessions

- Token `t = crypto.randomBytes(32).toString('base64url')`; the DB stores `tokenHash = sha256(t)`,
  `userId`, `expiresAt = now + SESSION_TTL` (30 days), `userAgent`. Always a **new** session per login.
- `SessionGuard` on every request: the `sid` cookie → hash → an active session →
  `request.currentUser`.
- `POST /api/auth/logout` → `revokedAt`, cookie cleared. An admin can revoke a user's sessions.
- The `sid` cookie: HttpOnly; Secure (prod); SameSite=Lax; Path=/; Max-Age = SESSION_TTL;
  Domain from `COOKIE_DOMAIN`.

## 8.3. Roles

| Capability | USER | ADMIN |
|------------|------|-------|
| Viewing/searching documents of accessible libraries, folders/collections, sharing, scan sets | ✅ | ✅ |
| Library management (creation, paths, intervals, visibility, rescan) | — | ✅ |
| User invites, role changes, deactivation, session revocation | — | ✅ |
| Category reference list | — | ✅ |
| Queue monitoring, retrying FAILED jobs, scan journals | — | ✅ |
| Document deletion (soft delete) | — | ✅ |

**Invariants:** the **last active admin** cannot be deactivated/demoted (`409 LAST_ADMIN`).
The role is stored on the user (`User.role`); checked by `RolesGuard` on top of `SessionGuard`.

## 8.4. CSRF, rate limiting, CAPTCHA

- **CSRF:** the SameSite=Lax cookie + `csrfOriginCheck` on **all mutations** (incl. login/register) —
  `Origin`/`Referer` compared against `APP_BASE_URL`, **fail-closed** (absent/mismatched → 403).
- **Rate limiting:** layer 1 — per-IP in-memory (`@nestjs/throttler`) on `/api/auth/*` and
  `/api/invites/*` (incl. protection against Argon2 flooding); layer 2 — per-email: `register/start`
  ≤1 code/60 s and ≤5/day; `register/verify` ≤5 wrong attempts → the record is burned; `login` —
  exponential backoff after 5 failures. Exceeding → `429 RATE_LIMITED`; all errors are generic.
- **CAPTCHA:** Cloudflare Turnstile on login and register/start; a `CaptchaVerifier` port; keys not set
  (dev) → no-op.

## 8.5. Content access model

Principles (the exact entity model — in 03):

- **Library → visibility.** Each library has a visibility setting: "all users" or an explicit list. A
  document from a library is visible to whoever the library is visible to (a document whose files live
  in several libraries is visible given access to at least one).
- **Derived documents** (merged scan-set PDFs) belong to their creator; visible to them and to whoever
  they share with.
- **Sharing.** A user can make their folders/collections (and derived documents) shared: with specific
  users or with the whole instance. Sharing grants **read** access; structure editing — owner only.
- **Personal organization** (folders/collections, notes) is private by default.
- `ADMIN` sees everything (instance maintenance).
- 🔒 Resource missing/soft-deleted → `404 *_NOT_FOUND`; exists but no access → `403 FORBIDDEN`.
- 🔒 File access happens only after the same access check as the document's metadata: derived
  artifacts from the private S3 bucket are served via **short-lived signed URLs**, library sources —
  streamed through the application. There are no direct/unauthenticated file links; a signed URL is
  never published in the UI as a permanent one.

Guards: `SessionGuard` (authn) → `RolesGuard` (admin routes) → `DocumentAccessGuard`
(resolves the document/library from path parameters + checks visibility/sharing).

## 8.6. Security checklist

- [ ] No open registration: one-time first-admin onboarding + single-use invite links
      (tokenHash, TTL, revocation).
- [ ] Registration — 3 steps with an email code (HMAC hash, TTL 10 min, ≤5 attempts); the `User` is
      created only at step 3 via a single-use ticket.
- [ ] Login: a single `INVALID_CREDENTIALS` + dummy verify; Argon2id; no JWT.
- [ ] Session: an opaque token stored as a hash, new per login, revoked on logout; cookie
      httpOnly/SameSite=Lax/Secure(prod).
- [ ] Mutations — fail-closed `csrfOriginCheck`; per-IP + per-email rate limiting; CAPTCHA on
      login/start.
- [ ] `passwordHash`/`tokenHash`/codes/tickets and email bodies are never serialized or logged.
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
