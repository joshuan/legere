import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import { instanceResponseSchema } from '../../src/shared/contracts/instance';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// What this server is actually running (docs/07 §7.3, docs/11 §11.13a).
describe('The instance view (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    app.emails.reset();
    seq += 1;
    adminCookie = await onboard(`instanceadmin${seq}@legere.local`);
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

  async function inviteUser(email: string): Promise<string> {
    const created = await api(app)
      .post('/api/admin/invites', { role: 'USER' })
      .set('Cookie', adminCookie);
    const token = expectData(created, createInviteResponseSchema).url.split('/').pop() ?? '';

    await api(app).post('/api/auth/register/start', { email, inviteToken: token });
    const verified = await api(app).post('/api/auth/register/verify', {
      email,
      code: app.emails.lastCodeFor(email),
    });
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
    expectData(completed, userDtoSchema);
    const cookie = cookieNamed(completed, 'sid');
    if (cookie === undefined) throw new Error('invited user has no session');
    return cookie;
  }

  it('answers an admin with the effective configuration, grouped', async () => {
    const res = await api(app).get('/api/admin/instance').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    const instance = expectData(res, instanceResponseSchema);
    expect(instance.groups.map((group) => group.key)).toEqual([
      'core',
      'database',
      'storage',
      'library',
      'processing',
      'ai',
      'email',
      'auth',
      'queue',
    ]);

    const rows = instance.groups.flatMap((group) => group.settings);
    const rowFor = (key: string) => rows.find((setting) => setting.key === key);
    // The environment the test process runs under (test/setup.server.ts), read back.
    expect(rowFor('APP_BASE_URL')).toMatchObject({ value: 'http://localhost:3000', source: 'ENV' });
    // The connection string is decomposed; the database it names is the test one.
    expect(rowFor('DATABASE_URL')).toBeUndefined();
    expect(rowFor('DATABASE_NAME')?.value).toBe('legere_test');
    // 🔒 The signing secret this very session is authenticated with says only that it exists.
    expect(rowFor('AUTH_SECRET')).toMatchObject({ value: null, source: 'SET' });

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(process.env.AUTH_SECRET);
    // Nor the connection string itself, in any row: it is where the password would ride along.
    // (What a password looks like once redacted is proved in instance-view.test.ts, where the
    // environment is built rather than inherited from whoever runs the suite.)
    expect(serialized).not.toContain(process.env.DATABASE_URL);
  });

  it('refuses everybody but an admin', async () => {
    const userCookie = await inviteUser(`nosy${seq}@legere.local`);

    const asUser = await api(app).get('/api/admin/instance').set('Cookie', userCookie);
    expect(asUser.status).toBe(403);
    expect(expectError(asUser).code).toBe('FORBIDDEN');

    const anonymous = await api(app).get('/api/admin/instance');
    expect(anonymous.status).toBe(401);
    expect(expectError(anonymous).code).toBe('UNAUTHENTICATED');
  });
});
