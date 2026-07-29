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
      email,
      code: app.emails.lastCodeFor(email),
    });
    return api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
  }

  function tokenFrom(url: string): string {
    const token = url.split('/').pop();
    if (token === undefined || token === '') throw new Error(`No token in ${url}`);
    return token;
  }

  describe('invites', () => {
    it('returns the invite URL exactly once and never stores the token', async () => {
      const created = await createInvite({ role: 'USER', emailHint: 'new@legere.local' });

      expect(created.status).toBe(201);
      const invite = expectData(created, createInviteResponseSchema);
      expect(invite.url).toContain('/invite/');
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

      const fresh = await api(app).get(`/api/invites/${token}`);
      expect(fresh.status).toBe(200);
      expect(expectData(fresh, invitePreviewSchema)).toMatchObject({ role: 'USER', valid: true });

      // Expired.
      await testPrisma().userInvite.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await api(app).get(`/api/invites/${token}`);
      expect(expectData(expired, invitePreviewSchema).valid).toBe(false);

      // Revoked.
      await testPrisma().userInvite.updateMany({
        data: { expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() },
      });
      const revoked = await api(app).get(`/api/invites/${token}`);
      expect(expectData(revoked, invitePreviewSchema).valid).toBe(false);

      // Accepted.
      await testPrisma().userInvite.updateMany({
        data: { revokedAt: null, acceptedAt: new Date() },
      });
      const accepted = await api(app).get(`/api/invites/${token}`);
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
      expect(reset.url).toContain('/reset/');

      const preview = await api(app).get(`/api/password-resets/${tokenFrom(reset.url)}`);
      const previewed = expectData(preview, passwordResetPreviewSchema);
      expect(previewed.valid).toBe(true);
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
});
