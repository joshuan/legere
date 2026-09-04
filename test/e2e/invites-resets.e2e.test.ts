import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  invitePreviewSchema,
  passwordResetPreviewSchema,
  registerVerifyResponseSchema,
  userDtoSchema,
} from '../../src/shared/contracts/auth';
import {
  createInviteResponseSchema,
  createPasswordResetResponseSchema,
  listInvitesResponseSchema,
  okResponseSchema,
} from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';
const NEW_PASSWORD = 'an-even-better-passphrase';

// Invites and admin-initiated password resets (docs/08 §8.1.2, §8.1.6, docs/07 invites/resets).
describe('Invites and password resets (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  // A fresh address per test: the per-email send cap (5/day, docs/08 §8.4) is in-memory and
  // therefore survives the database truncation between tests.
  let adminSeq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    app.emails.reset();
    adminSeq += 1;
    adminCookie = await onboard(`admin${adminSeq}@legere.local`);
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  async function onboard(email: string): Promise<string> {
    await api(app).post('/api/auth/register/start', { email });
    const verified = await api(app).post('/api/auth/register/verify', {
      email,
      code: app.emails.lastCodeFor(email),
    });
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
    const sid = cookieNamed(completed, 'sid');
    if (sid === undefined) throw new Error('onboarding did not set a session cookie');
    return sid;
  }

  const createInvite = (body: Record<string, unknown> = { role: 'USER' }) =>
    api(app).post('/api/admin/invites', body).set('Cookie', adminCookie);

  // Registers through an invite link and returns the created user's session cookie.
  async function acceptInvite(token: string, email: string) {
    await api(app).post('/api/auth/register/start', { email, inviteToken: token });
    const verified = await api(app).post('/api/auth/register/verify', {
      inviteToken: token,
      email,
      code: app.emails.lastCodeFor(email),
    });
    return api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
  }

  // Everything up to the last step: an address gets its own registration ticket against a shared
  // invite. Two of these exist at once whenever an attacker starts a series per address on one
  // link, which is what makes the single-use rule a race rather than a lookup.
  async function ticketForInvite(token: string, email: string): Promise<string> {
    await api(app).post('/api/auth/register/start', { email, inviteToken: token });
    const verified = await api(app).post('/api/auth/register/verify', {
      inviteToken: token,
      email,
      code: app.emails.lastCodeFor(email),
    });
    return expectData(verified, registerVerifyResponseSchema).ticket;
  }

  const completeWith = (ticket: string) =>
    api(app).post('/api/auth/register/complete', { ticket, password: PASSWORD });

  function tokenFrom(url: string): string {
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get('token');
    if (token === null || token === '') throw new Error(`No token in ${url}`);
    return token;
  }

  describe('invites', () => {
    it('returns the invite URL exactly once and never stores the token', async () => {
      const created = await createInvite({ role: 'USER', emailHint: 'new@legere.local' });

      expect(created.status).toBe(201);
      const invite = expectData(created, createInviteResponseSchema);
      expect(new URL(invite.url).pathname).toBe('/invite');
      expect(new URL(invite.url).search).toBe('');
      expect(new URL(invite.url).hash).toMatch(/^#token=/);
      expect(invite.role).toBe('USER');

      // The listing never repeats the token, and the database holds only its hash.
      const listed = await api(app).get('/api/admin/invites').set('Cookie', adminCookie);
      const items = expectData(listed, listInvitesResponseSchema).items;
      expect(items).toHaveLength(1);
      expect(JSON.stringify(items)).not.toContain(tokenFrom(invite.url));

      const stored = await testPrisma().userInvite.findFirstOrThrow();
      expect(stored.tokenHash).not.toBe(tokenFrom(invite.url));
      expect(stored.tokenHash).toHaveLength(64);
    });

    it('previews a valid invite and reports invalidity for used, revoked and expired ones', async () => {
      const invite = expectData(await createInvite(), createInviteResponseSchema);
      const token = tokenFrom(invite.url);

      const fresh = await api(app).post('/api/invites/preview', { token });
      expect(fresh.status).toBe(200);
      expect(expectData(fresh, invitePreviewSchema)).toMatchObject({ role: 'USER', valid: true });
      expect((await api(app).get(`/api/invites/${token}`)).status).toBe(404);

      // Expired.
      await testPrisma().userInvite.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await api(app).post('/api/invites/preview', { token });
      expect(expectData(expired, invitePreviewSchema).valid).toBe(false);

      // Revoked.
      await testPrisma().userInvite.updateMany({
        data: { expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() },
      });
      const revoked = await api(app).post('/api/invites/preview', { token });
      expect(expectData(revoked, invitePreviewSchema).valid).toBe(false);

      // Accepted.
      await testPrisma().userInvite.updateMany({
        data: { revokedAt: null, acceptedAt: new Date() },
      });
      const accepted = await api(app).post('/api/invites/preview', { token });
      expect(expectData(accepted, invitePreviewSchema).valid).toBe(false);
    });

    it('creates the user with the invite role and marks the invite used', async () => {
      const invite = expectData(await createInvite({ role: 'ADMIN' }), createInviteResponseSchema);

      const completed = await acceptInvite(tokenFrom(invite.url), 'invited@legere.local');

      expect(completed.status).toBe(200);
      expect(expectData(completed, userDtoSchema)).toMatchObject({
        email: 'invited@legere.local',
        role: 'ADMIN',
      });

      const stored = await testPrisma().userInvite.findFirstOrThrow();
      expect(stored.acceptedAt).not.toBeNull();
      expect(stored.acceptedById).not.toBeNull();

      // A used invite drops out of the active listing and cannot be used again.
      const listed = await api(app).get('/api/admin/invites').set('Cookie', adminCookie);
      expect(expectData(listed, listInvitesResponseSchema).items).toHaveLength(0);

      const reuse = await api(app).post('/api/auth/register/start', {
        email: 'second@legere.local',
        inviteToken: tokenFrom(invite.url),
      });
      expect(reuse.status).toBe(400);
      expect(expectError(reuse).code).toBe('INVITE_INVALID');
    });

    it('refuses a revoked and an expired invite at registration', async () => {
      const revokedInvite = expectData(await createInvite(), createInviteResponseSchema);
      const revoke = await api(app)
        .delete(`/api/admin/invites/${revokedInvite.id}`)
        .set('Cookie', adminCookie);
      expect(revoke.status).toBe(200);
      expect(expectData(revoke, okResponseSchema)).toEqual({ ok: true });

      const afterRevoke = await api(app).post('/api/auth/register/start', {
        email: 'nope@legere.local',
        inviteToken: tokenFrom(revokedInvite.url),
      });
      expect(expectError(afterRevoke).code).toBe('INVITE_INVALID');

      const expiredInvite = expectData(await createInvite(), createInviteResponseSchema);
      await testPrisma().userInvite.updateMany({
        where: { id: expiredInvite.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const afterExpiry = await api(app).post('/api/auth/register/start', {
        email: 'nope2@legere.local',
        inviteToken: tokenFrom(expiredInvite.url),
      });
      expect(expectError(afterExpiry).code).toBe('INVITE_INVALID');
    });

    // 🔒 SEC-04: one link, two tickets. Completion re-reads the invite inside its transaction, so
    // the second registration finds it spent (docs/08 §8.1.2, "single-use link").
    it('mints one account when two registrations complete against the same invite in turn', async () => {
      const invite = expectData(await createInvite({ role: 'ADMIN' }), createInviteResponseSchema);
      const token = tokenFrom(invite.url);
      const first = await ticketForInvite(token, 'shadow-a@legere.local');
      const second = await ticketForInvite(token, 'shadow-b@legere.local');

      expect((await completeWith(first)).status).toBe(200);

      const reused = await completeWith(second);
      expect(reused.status).toBe(400);
      expect(expectError(reused).code).toBe('INVITE_INVALID');

      // The onboarded admin plus exactly one invited admin — no copy the panel cannot see.
      expect(await testPrisma().user.count({ where: { role: 'ADMIN' } })).toBe(2);
      expect(await testPrisma().user.count({ where: { email: 'shadow-b@legere.local' } })).toBe(0);
    });

    // 🔒 SEC-04: the same, with both completions in flight together. READ COMMITTED lets both read
    // an unaccepted invite, so only the conditional write in markAccepted can separate them.
    it('mints one account when two registrations complete against the same invite at once', async () => {
      const invite = expectData(await createInvite({ role: 'ADMIN' }), createInviteResponseSchema);
      const token = tokenFrom(invite.url);
      const tickets = [
        await ticketForInvite(token, 'racer-a@legere.local'),
        await ticketForInvite(token, 'racer-b@legere.local'),
      ];

      const results = await Promise.all(tickets.map((ticket) => completeWith(ticket)));

      const succeeded = results.filter((res) => res.status === 200);
      const rejected = results.filter((res) => res.status !== 200);
      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const failure = rejected[0];
      if (failure === undefined) throw new Error('expected one rejection');
      expect(expectError(failure).code).toBe('INVITE_INVALID');

      expect(await testPrisma().user.count({ where: { role: 'ADMIN' } })).toBe(2);
      const stored = await testPrisma().userInvite.findFirstOrThrow();
      expect(stored.acceptedAt).not.toBeNull();
    });

    it('refuses a completion when the invite is revoked inside the ticket window', async () => {
      const invite = expectData(await createInvite({ role: 'ADMIN' }), createInviteResponseSchema);
      const ticket = await ticketForInvite(tokenFrom(invite.url), 'revoked@legere.local');

      await api(app).delete(`/api/admin/invites/${invite.id}`).set('Cookie', adminCookie);

      const res = await completeWith(ticket);
      expect(res.status).toBe(400);
      expect(expectError(res).code).toBe('INVITE_INVALID');
      expect(await testPrisma().user.count({ where: { email: 'revoked@legere.local' } })).toBe(0);
    });

    it('refuses a completion when the invite expires inside the ticket window', async () => {
      const invite = expectData(await createInvite(), createInviteResponseSchema);
      const ticket = await ticketForInvite(tokenFrom(invite.url), 'stale@legere.local');

      await testPrisma().userInvite.updateMany({
        where: { id: invite.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await completeWith(ticket);
      expect(res.status).toBe(400);
      expect(expectError(res).code).toBe('INVITE_INVALID');
      expect(await testPrisma().user.count({ where: { email: 'stale@legere.local' } })).toBe(0);
    });

    it('is admin-only', async () => {
      const invite = expectData(await createInvite(), createInviteResponseSchema);
      const userSession = await acceptInvite(tokenFrom(invite.url), 'plain@legere.local');
      const userCookie = cookieNamed(userSession, 'sid');
      if (userCookie === undefined) throw new Error('no session for the invited user');

      const asUser = await api(app)
        .post('/api/admin/invites', { role: 'USER' })
        .set('Cookie', userCookie);
      expect(asUser.status).toBe(403);
      expect(expectError(asUser).code).toBe('FORBIDDEN');

      const anonymous = await api(app).post('/api/admin/invites', { role: 'USER' });
      expect(anonymous.status).toBe(401);
      expect(expectError(anonymous).code).toBe('UNAUTHENTICATED');
    });
  });

  describe('password resets', () => {
    async function createReset(userId: string) {
      return api(app).post(`/api/admin/users/${userId}/password-reset`).set('Cookie', adminCookie);
    }

    it('hands the admin a one-time link and masks the address in the preview', async () => {
      const target = await testPrisma().user.findFirstOrThrow();
      const created = await createReset(target.id);

      expect(created.status).toBe(201);
      const reset = expectData(created, createPasswordResetResponseSchema);
      expect(new URL(reset.url).pathname).toBe('/reset');
      expect(new URL(reset.url).search).toBe('');
      expect(new URL(reset.url).hash).toMatch(/^#token=/);

      const preview = await api(app).post('/api/password-resets/preview', {
        token: tokenFrom(reset.url),
      });
      const previewed = expectData(preview, passwordResetPreviewSchema);
      expect(previewed.valid).toBe(true);
      expect((await api(app).get(`/api/password-resets/${tokenFrom(reset.url)}`)).status).toBe(404);
      // Masked: recognisable to its owner, useless for harvesting.
      expect(previewed.email).not.toBe(target.email);
      expect(previewed.email).toMatch(/^.\*\*\*.@legere\.local$/);

      const stored = await testPrisma().passwordReset.findFirstOrThrow();
      expect(stored.tokenHash).not.toBe(tokenFrom(reset.url));
    });

    it('changes the password through the code flow and revokes every existing session', async () => {
      const target = await testPrisma().user.findFirstOrThrow();
      const email = target.email;
      const reset = expectData(await createReset(target.id), createPasswordResetResponseSchema);

      // The admin's own pre-existing session is one of the sessions this must kill.
      const sessionsBefore = await testPrisma().session.count({
        where: { userId: target.id, revokedAt: null },
      });
      expect(sessionsBefore).toBeGreaterThan(0);

      await api(app).post('/api/auth/register/start', {
        email,
        resetToken: tokenFrom(reset.url),
      });
      const verified = await api(app).post('/api/auth/register/verify', {
        email,
        code: app.emails.lastCodeFor(email),
        resetToken: tokenFrom(reset.url),
      });
      const completed = await api(app).post('/api/auth/register/complete', {
        ticket: expectData(verified, registerVerifyResponseSchema).ticket,
        password: NEW_PASSWORD,
      });
      expect(completed.status).toBe(200);

      // Old sessions are gone; only the one just issued survives.
      const stillActive = await testPrisma().session.findMany({
        where: { userId: target.id, revokedAt: null },
      });
      expect(stillActive).toHaveLength(1);
      expect(cookieNamed(completed, 'sid')).toBeDefined();

      // The new password works and the old one does not.
      expect(
        (await api(app).post('/api/auth/login', { email, password: NEW_PASSWORD })).status,
      ).toBe(200);
      expect((await api(app).post('/api/auth/login', { email, password: PASSWORD })).status).toBe(
        401,
      );

      // The link is single-use.
      const reuse = await api(app).post('/api/auth/register/start', {
        email,
        resetToken: tokenFrom(reset.url),
      });
      expect(expectError(reuse).code).toBe('RESET_INVALID');
    });

    // A second account to deactivate: the last admin cannot be blocked (docs/03 §3.3.1).
    async function invitedUser(email: string) {
      const invite = expectData(await createInvite(), createInviteResponseSchema);
      expect((await acceptInvite(tokenFrom(invite.url), email)).status).toBe(200);
      return testPrisma().user.findFirstOrThrow({ where: { email } });
    }

    // Everything up to the last step of a reset series.
    async function ticketForReset(token: string, email: string): Promise<string> {
      await api(app).post('/api/auth/register/start', { email, resetToken: token });
      const verified = await api(app).post('/api/auth/register/verify', {
        resetToken: token,
        email,
        code: app.emails.lastCodeFor(email),
      });
      return expectData(verified, registerVerifyResponseSchema).ticket;
    }

    // 🔒 SEC-24: the ticket lives fifteen minutes, and an admin can block the account inside them.
    // Deactivation exists to cut every route back in; completion was not one of them.
    it('refuses a reset whose account was deactivated inside the ticket window', async () => {
      const target = await invitedUser('deactivated-target@legere.local');
      const reset = expectData(await createReset(target.id), createPasswordResetResponseSchema);
      const ticket = await ticketForReset(tokenFrom(reset.url), target.email);

      const blocked = await api(app)
        .post(`/api/admin/users/${target.id}/deactivate`)
        .set('Cookie', adminCookie);
      expect(blocked.status).toBe(200);

      const completed = await api(app).post('/api/auth/register/complete', {
        ticket,
        password: NEW_PASSWORD,
      });
      expect(completed.status).toBe(400);
      expect(expectError(completed).code).toBe('RESET_INVALID');

      // Nothing was written: reactivating the account must not hand it to whoever held the link.
      const after = await testPrisma().user.findUniqueOrThrow({ where: { id: target.id } });
      expect(after.passwordHash).toBe(target.passwordHash);
      expect(
        await testPrisma().passwordReset.count({ where: { userId: target.id, usedAt: null } }),
      ).toBe(1);
    });

    // The same door from the other side: the account is active again, but the link it belonged to
    // was revoked while the ticket was outstanding.
    it('refuses a reset whose link was revoked inside the ticket window', async () => {
      const target = await invitedUser('revoked-target@legere.local');
      const reset = expectData(await createReset(target.id), createPasswordResetResponseSchema);
      const ticket = await ticketForReset(tokenFrom(reset.url), target.email);

      await api(app).post(`/api/admin/users/${target.id}/deactivate`).set('Cookie', adminCookie);
      const restored = await api(app)
        .post(`/api/admin/users/${target.id}/reactivate`)
        .set('Cookie', adminCookie);
      expect(restored.status).toBe(200);

      const completed = await api(app).post('/api/auth/register/complete', {
        ticket,
        password: NEW_PASSWORD,
      });
      expect(completed.status).toBe(400);
      expect(expectError(completed).code).toBe('RESET_INVALID');

      const after = await testPrisma().user.findUniqueOrThrow({ where: { id: target.id } });
      expect(after.passwordHash).toBe(target.passwordHash);
    });

    it('refuses to issue a reset for a deactivated user', async () => {
      const target = await testPrisma().user.findFirstOrThrow();
      await testPrisma().user.update({
        where: { id: target.id },
        data: { deactivatedAt: new Date() },
      });

      const res = await createReset(target.id);
      expect(res.status).toBe(403);
      expect(expectError(res).code).toBe('FORBIDDEN');
    });

    it('404s for an unknown user', async () => {
      const res = await createReset('11111111-1111-4111-8111-111111111111');
      expect(res.status).toBe(404);
      expect(expectError(res).code).toBe('USER_NOT_FOUND');
    });
  });

  // 🔒 SEC-19: one valid invite used to let a stranger send this instance's letters to any address
  // they chose, and — while the daily cap was shared across purposes — thereby deny that address a
  // password reset for a day.
  describe('an invite is an invitation to somebody', () => {
    it('refuses a registration started for an address the invite does not name', async () => {
      const invite = await api(app)
        .post('/api/admin/invites', { role: 'USER', emailHint: 'wanted@legere.local' })
        .set('Cookie', adminCookie);
      const token = tokenFrom(expectData(invite, createInviteResponseSchema).url);

      const refused = await api(app).post('/api/auth/register/start', {
        email: 'somebody-else@legere.local',
        inviteToken: token,
      });

      expect(refused.status).toBe(400);
      expect(expectError(refused).code).toBe('INVITE_INVALID');
    });

    it('still lets an invite with no hint be taken by whoever holds it', async () => {
      const invite = await api(app)
        .post('/api/admin/invites', { role: 'USER' })
        .set('Cookie', adminCookie);
      const token = tokenFrom(expectData(invite, createInviteResponseSchema).url);

      const started = await api(app).post('/api/auth/register/start', {
        email: 'anybody@legere.local',
        inviteToken: token,
      });

      expect(started.status).toBe(200);
    });

    it('ignores the case and the spacing an admin typed the hint with', async () => {
      const invite = await api(app)
        .post('/api/admin/invites', { role: 'USER', emailHint: '  Wanted@Legere.Local ' })
        .set('Cookie', adminCookie);
      const token = tokenFrom(expectData(invite, createInviteResponseSchema).url);

      const started = await api(app).post('/api/auth/register/start', {
        email: 'wanted@legere.local',
        inviteToken: token,
      });

      expect(started.status).toBe(200);
    });
  });
});
