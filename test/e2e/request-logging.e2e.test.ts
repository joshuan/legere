import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import {
  createInviteResponseSchema,
  createPasswordResetResponseSchema,
} from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n');

// 🔒 SEC-10 (docs/06 §6.7, docs/08 §8.1.2, §8.1.6). Two links this application hands out are bearer
// credentials living in a path segment, and `pino-http` writes the URL of every request it serves.
// The suite therefore reads what the process actually emitted rather than what a serializer returns
// in isolation: the request log runs through Express, Nest, a guard and a throttler first, and the
// question is what comes out the far end.
describe('Request logging (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let inviteToken: string;
  let resetToken: string;
  const emitted: string[] = [];
  const previousLevel = process.env.LOG_LEVEL;

  // The whole suite runs at `info` — the level the shipped deployment runs at (docs/12 §12.4) —
  // and stdout is captured before the app is built, because pino chooses its destination when the
  // middleware is created and a spy installed later would see nothing.
  beforeAll(async () => {
    process.env.LOG_LEVEL = 'info';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      emitted.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });

    app = await createTestApp();
    await truncateAll();
    adminCookie = await onboard('log-admin@legere.local');

    const invite = expectData(
      await api(app).post('/api/admin/invites', { role: 'USER' }).set('Cookie', adminCookie),
      createInviteResponseSchema,
    );
    inviteToken = tokenFrom(invite.url);

    const admin = await testPrisma().user.findFirstOrThrow();
    const reset = expectData(
      await api(app).post(`/api/admin/users/${admin.id}/password-reset`).set('Cookie', adminCookie),
      createPasswordResetResponseSchema,
    );
    resetToken = tokenFrom(reset.url);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
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

  function tokenFrom(url: string): string {
    const token = url.split('/').pop();
    if (token === undefined || token === '') throw new Error(`No token in ${url}`);
    return token;
  }

  const log = () => emitted.join('');

  it('writes the route and not the token when an invite link is previewed', async () => {
    const before = log();
    const preview = await api(app).get(`/api/invites/${inviteToken}`);

    expect(preview.status).toBe(200);
    const written = log().slice(before.length);
    // The request was logged — otherwise "the token is absent" would pass for the wrong reason.
    expect(written).toContain('"url":"/api/invites/:x"');
    expect(written).not.toContain(inviteToken);
  });

  it('writes the route and not the token when a reset link is previewed', async () => {
    const before = log();
    const preview = await api(app).get(`/api/password-resets/${resetToken}`);

    expect(preview.status).toBe(200);
    const written = log().slice(before.length);
    expect(written).toContain('"url":"/api/password-resets/:x"');
    expect(written).not.toContain(resetToken);
  });

  it('keeps neither token anywhere in everything the process has emitted', () => {
    expect(log()).not.toContain(inviteToken);
    expect(log()).not.toContain(resetToken);
  });

  it('never says what somebody searched their archive for', async () => {
    const before = log();
    const found = await api(app).get('/api/search?q=biopsy-results').set('Cookie', adminCookie);

    expect(found.status).toBe(200);
    const written = log().slice(before.length);
    expect(written).toContain('"url":"/api/search"');
    expect(written).not.toContain('biopsy-results');
  });

  it('never says what a document is called', async () => {
    const before = log();
    const uploaded = await api(app)
      .postBinary('/api/documents', PDF)
      .set('Cookie', adminCookie)
      .set('X-Legere-Filename', encodeURIComponent('biopsy results 2026.pdf'));

    expect(uploaded.status).toBe(201);
    const written = log().slice(before.length);
    expect(written).toContain('"url":"/api/documents"');
    expect(written).not.toContain('biopsy');
  });
});
