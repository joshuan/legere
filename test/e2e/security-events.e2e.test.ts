import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import {
  createInviteResponseSchema,
  createPasswordResetResponseSchema,
  listSessionsResponseSchema,
  createApiTokenResponseSchema,
} from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';
const NEXT_PASSWORD = 'an-even-better-passphrase';
const ADMIN = 'journal-admin@legere.local';
const MEMBER = 'journal-member@legere.local';

// 🔒 SEC-34 (docs/06 §6.7, docs/08 §8.6). An account has a history: every sign-in, every credential
// handed out, every change of authority is one structured line naming who did it, to whom, under
// which request and when. The suite reads what the process actually emitted rather than what a port
// returns in isolation, because the question is what comes out of a running instance — and because
// "no code, token or password ever reaches a record" can only be asked of the bytes.
describe('Security events (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let adminId: string;
  let memberId: string;
  let memberCookie: string;
  let inviteToken: string;
  const emitted: string[] = [];
  const previousLevel = process.env.LOG_LEVEL;
  // Everything the instance was ever told, so the last test can prove none of it was written down.
  const credentials: string[] = [PASSWORD, NEXT_PASSWORD];

  // The whole suite runs at `info`, the level a shipped deployment runs at (docs/12 §12.4), and
  // stdout is captured before the app is built: pino picks its destination when the logger is
  // created, and a spy installed later would see nothing.
  beforeAll(async () => {
    process.env.LOG_LEVEL = 'info';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      emitted.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });

    app = await createTestApp();
    await truncateAll();
    adminCookie = await onboard(ADMIN);
    adminId = (await testPrisma().user.findFirstOrThrow({ where: { email: ADMIN } })).id;
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
    const code = app.emails.lastCodeFor(email);
    credentials.push(code);
    const verified = await api(app).post('/api/auth/register/verify', { email, code });
    const ticket = expectData(verified, registerVerifyResponseSchema).ticket;
    credentials.push(ticket);
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket,
      password: PASSWORD,
    });
    const sid = cookieNamed(completed, 'sid');
    if (sid === undefined) throw new Error('onboarding did not set a session cookie');
    return sid;
  }

  function tokenFrom(url: string): string {
    const token = url.split('/').pop();
    if (token === undefined || token === '') throw new Error(`No token in ${url}`);
    credentials.push(token);
    return token;
  }

  const log = () => emitted.join('');

  // Everything the process wrote under `context: "security"` since a mark, parsed back.
  function recordsSince(mark: number): Array<Record<string, unknown>> {
    return log()
      .slice(mark)
      .split('\n')
      .filter((line) => line.includes('"context":"security"'))
      .map((line): Record<string, unknown> => {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object') throw new Error(`Not JSON: ${line}`);
        return { ...parsed };
      });
  }

  function onlyRecord(mark: number): Record<string, unknown> {
    const found = recordsSince(mark);
    const [first] = found;
    if (first === undefined || found.length !== 1) {
      throw new Error(`Expected one security record, got ${found.length}`);
    }
    return first;
  }

  it('records the first administrator the instance ever had', () => {
    const [created] = recordsSince(0).filter((record) => record['event'] === 'account.created');

    expect(created).toMatchObject({
      context: 'security',
      event: 'account.created',
      actor: { userId: adminId },
      target: { userId: adminId },
      detail: { role: 'ADMIN' },
    });
    expect(typeof created?.['time']).toBe('number');
    expect(typeof created?.['requestId']).toBe('string');
  });

  it('joins a record to the request that caused it by the id the request already answers with', async () => {
    const mark = log().length;
    const created = await api(app)
      .post('/api/admin/invites', { role: 'USER', emailHint: MEMBER })
      .set('Cookie', adminCookie);

    expect(created.status).toBe(201);
    const record = onlyRecord(mark);
    // The same id the caller was handed, and the same id on the request line beside it: one grep
    // for it produces the whole story of that call (docs/06 §6.7).
    expect(record['requestId']).toBe(created.headers['x-request-id']);
    const written = log().slice(mark);
    expect(written).toContain(`"url":"/api/admin/invites"`);

    inviteToken = tokenFrom(expectData(created, createInviteResponseSchema).url);
  });

  it('records an invite issued, naming the admin who issued it and the role it grants', () => {
    const [issued] = recordsSince(0).filter((record) => record['event'] === 'invite.issued');

    expect(issued).toMatchObject({
      event: 'invite.issued',
      actor: { userId: adminId },
      target: { email: MEMBER },
      detail: { role: 'USER' },
    });
  });

  it('records an invite accepted against the account it created', async () => {
    const mark = log().length;
    await api(app).post('/api/auth/register/start', { email: MEMBER, inviteToken });
    const code = app.emails.lastCodeFor(MEMBER);
    credentials.push(code);
    const verified = await api(app).post('/api/auth/register/verify', {
      inviteToken,
      email: MEMBER,
      code,
    });
    const ticket = expectData(verified, registerVerifyResponseSchema).ticket;
    credentials.push(ticket);
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket,
      password: PASSWORD,
    });

    expect(completed.status).toBe(200);
    memberCookie = cookieNamed(completed, 'sid') ?? '';
    memberId = (await testPrisma().user.findFirstOrThrow({ where: { email: MEMBER } })).id;

    const accepted = recordsSince(mark);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      event: 'invite.accepted',
      actor: { userId: memberId },
      target: { userId: memberId },
      detail: { role: 'USER' },
    });
  });

  it('records a successful sign-in with the account, the address and where it came from', async () => {
    const mark = log().length;
    const signedIn = await api(app).post('/api/auth/login', { email: MEMBER, password: PASSWORD });

    expect(signedIn.status).toBe(200);
    const record = onlyRecord(mark);
    expect(record).toMatchObject({
      event: 'login.succeeded',
      actor: { userId: memberId, ip: '127.0.0.1' },
      target: { userId: memberId, email: MEMBER },
    });
    expect(record['requestId']).toBe(signedIn.headers['x-request-id']);
  });

  it('records a refused sign-in against the address attempted, existing or not', async () => {
    const mark = log().length;
    await api(app).post('/api/auth/login', { email: MEMBER, password: 'not-the-password' });
    await api(app).post('/api/auth/login', { email: 'nobody@legere.local', password: 'guess' });

    const [known, unknown] = recordsSince(mark);
    // 🔒 The two records differ in the address and in nothing else. Whether the account exists is
    // what login refuses to tell an attacker (docs/08 §8.1.4); a record that told a log reader
    // instead would have moved the oracle rather than closed it.
    expect(known).toMatchObject({
      event: 'login.failed',
      actor: { userId: null },
      target: { email: MEMBER },
      detail: { reason: 'INVALID_CREDENTIALS' },
    });
    expect(unknown).toMatchObject({
      event: 'login.failed',
      actor: { userId: null },
      target: { email: 'nobody@legere.local' },
      detail: { reason: 'INVALID_CREDENTIALS' },
    });
    expect(Object.keys(known ?? {}).sort()).toEqual(Object.keys(unknown ?? {}).sort());
  });

  it('records the lockout as an event of its own once the backoff refuses an attempt', async () => {
    const attacked = 'locked-out@legere.local';
    const mark = log().length;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await api(app).post('/api/auth/login', { email: attacked, password: 'guess' });
    }

    expect(recordsSince(mark).map((record) => record['event'])).toEqual([
      'login.failed',
      'login.failed',
      'login.failed',
      'login.failed',
      'login.throttled',
    ]);
  });

  it('records a password reset issued by an admin and completed by its owner', async () => {
    const issuedMark = log().length;
    const created = await api(app)
      .post(`/api/admin/users/${memberId}/password-reset`)
      .set('Cookie', adminCookie);
    expect(created.status).toBe(201);
    const resetToken = tokenFrom(expectData(created, createPasswordResetResponseSchema).url);

    expect(onlyRecord(issuedMark)).toMatchObject({
      event: 'password_reset.issued',
      actor: { userId: adminId },
      target: { userId: memberId },
    });

    const completedMark = log().length;
    await api(app).post('/api/auth/register/start', { email: MEMBER, resetToken });
    const code = app.emails.lastCodeFor(MEMBER);
    credentials.push(code);
    const verified = await api(app).post('/api/auth/register/verify', {
      resetToken,
      email: MEMBER,
      code,
    });
    const ticket = expectData(verified, registerVerifyResponseSchema).ticket;
    credentials.push(ticket);
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket,
      password: NEXT_PASSWORD,
    });

    expect(completed.status).toBe(200);
    memberCookie = cookieNamed(completed, 'sid') ?? '';
    expect(onlyRecord(completedMark)).toMatchObject({
      event: 'password_reset.completed',
      actor: { userId: memberId },
      target: { userId: memberId },
    });
  });

  it('records a self-service password change with the sessions it ended', async () => {
    const mark = log().length;
    const changed = await api(app)
      .post('/api/me/password', { currentPassword: NEXT_PASSWORD, newPassword: PASSWORD })
      .set('Cookie', memberCookie);

    expect(changed.status).toBe(200);
    expect(onlyRecord(mark)).toMatchObject({
      event: 'password.changed',
      actor: { userId: memberId },
      target: { userId: memberId },
    });
  });

  it('records an API token created and revoked against its owner', async () => {
    const createdMark = log().length;
    const created = await api(app)
      .post('/api/me/api-tokens', { name: 'export script' })
      .set('Cookie', memberCookie);
    expect(created.status).toBe(201);
    const token = expectData(created, createApiTokenResponseSchema);
    credentials.push(token.token);

    expect(onlyRecord(createdMark)).toMatchObject({
      event: 'api_token.created',
      actor: { userId: memberId },
      target: { userId: memberId, id: token.apiToken.id },
    });

    const revokedMark = log().length;
    await api(app).delete(`/api/me/api-tokens/${token.apiToken.id}`).set('Cookie', memberCookie);
    expect(onlyRecord(revokedMark)).toMatchObject({
      event: 'api_token.revoked',
      actor: { userId: memberId },
      target: { userId: memberId, id: token.apiToken.id },
    });
  });

  it('records a session a user ends themselves, and one an admin ends for them', async () => {
    const listed = await api(app).get('/api/me/sessions').set('Cookie', memberCookie);
    const own = expectData(listed, listSessionsResponseSchema).items[0];
    if (own === undefined) throw new Error('the member has no session to end');

    const ownMark = log().length;
    await api(app).delete(`/api/me/sessions/${own.id}`).set('Cookie', memberCookie);
    expect(onlyRecord(ownMark)).toMatchObject({
      event: 'session.revoked',
      actor: { userId: memberId },
      target: { userId: memberId, id: own.id },
      detail: { sessions: 1 },
    });

    const adminMark = log().length;
    const revoked = await api(app)
      .post(`/api/admin/users/${memberId}/revoke-sessions`)
      .set('Cookie', adminCookie);
    expect(revoked.status).toBe(200);
    expect(onlyRecord(adminMark)).toMatchObject({
      event: 'session.revoked',
      actor: { userId: adminId },
      target: { userId: memberId },
    });
  });

  it('records a role change, a deactivation and a reactivation against the admin who made them', async () => {
    const roleMark = log().length;
    const promoted = await api(app)
      .patch(`/api/admin/users/${memberId}`, { role: 'ADMIN' })
      .set('Cookie', adminCookie);
    expect(promoted.status).toBe(200);
    expect(onlyRecord(roleMark)).toMatchObject({
      event: 'role.changed',
      actor: { userId: adminId },
      target: { userId: memberId },
      detail: { fromRole: 'USER', role: 'ADMIN' },
    });

    // Setting the same role again changes nothing, and a journal of no-ops is one nobody reads.
    const idleMark = log().length;
    await api(app)
      .patch(`/api/admin/users/${memberId}`, { role: 'ADMIN' })
      .set('Cookie', adminCookie);
    expect(recordsSince(idleMark)).toEqual([]);

    const blockedMark = log().length;
    const blocked = await api(app)
      .post(`/api/admin/users/${memberId}/deactivate`)
      .set('Cookie', adminCookie);
    expect(blocked.status).toBe(200);
    expect(onlyRecord(blockedMark)).toMatchObject({
      event: 'account.deactivated',
      actor: { userId: adminId },
      target: { userId: memberId },
    });

    const restoredMark = log().length;
    await api(app).post(`/api/admin/users/${memberId}/reactivate`).set('Cookie', adminCookie);
    expect(onlyRecord(restoredMark)).toMatchObject({
      event: 'account.reactivated',
      actor: { userId: adminId },
      target: { userId: memberId },
    });
  });

  it('records an invite revoked, naming the admin who revoked it', async () => {
    const created = await api(app)
      .post('/api/admin/invites', { role: 'USER' })
      .set('Cookie', adminCookie);
    const invite = expectData(created, createInviteResponseSchema);
    tokenFrom(invite.url);

    const mark = log().length;
    const revoked = await api(app)
      .delete(`/api/admin/invites/${invite.id}`)
      .set('Cookie', adminCookie);

    expect(revoked.status).toBe(200);
    expect(onlyRecord(mark)).toMatchObject({
      event: 'invite.revoked',
      actor: { userId: adminId },
      target: { id: invite.id },
    });
  });

  it('every record it has written names an actor, a target, a request and a time', () => {
    const records = recordsSince(0);
    expect(records.length).toBeGreaterThan(15);

    for (const record of records) {
      expect(record['actor']).toBeTypeOf('object');
      expect(record['target']).toBeTypeOf('object');
      expect(typeof record['requestId']).toBe('string');
      expect(typeof record['time']).toBe('number');
      expect(record['msg']).toBe(`security.${String(record['event'])}`);
    }
  });

  // 🔒 The acceptance the whole feature stands on: a journal that leaks a credential is a worse
  // problem than the one it was built to solve (docs/08 §8.6, SEC-10).
  it('keeps no password, code, ticket or token anywhere in anything it recorded', () => {
    const written = JSON.stringify(recordsSince(0));

    expect(credentials.length).toBeGreaterThan(8);
    for (const credential of credentials) {
      expect(written).not.toContain(credential);
    }
  });
});
