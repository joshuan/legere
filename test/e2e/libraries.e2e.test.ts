import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import {
  libraryAdminDtoSchema,
  listLibrariesAdminResponseSchema,
  listLibrariesResponseSchema,
  listScanRunsResponseSchema,
  pathCandidatesResponseSchema,
  triggerScanResponseSchema,
} from '../../src/shared/contracts/libraries';
import { createInviteResponseSchema, okResponseSchema } from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// Creating a library commits a scan job with it (docs/05 §5.2), and a second scan for the same
// library collapses into that one. These tests run no workers, so the queued job is removed here to
// stand in for a worker having taken it.
async function takeQueuedScans(): Promise<void> {
  await testPrisma().$executeRawUnsafe("DELETE FROM pgboss.job WHERE name = 'library-scan'");
}

// Libraries admin API and visibility (docs/07 §7.3, docs/03 §3.3.6–3.3.7, docs/08 §8.5).
describe('Libraries (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let seq = 0;

  // LIBRARY_ROOT for the test process (test/setup.server.ts); the fixtures below live inside it.
  const libraryRoot = process.env.LIBRARY_ROOT ?? '/tmp/test-library';

  beforeAll(async () => {
    await mkdir(join(libraryRoot, 'invoices', '2026'), { recursive: true });
    await mkdir(join(libraryRoot, 'receipts'), { recursive: true });
    await mkdir(join(libraryRoot, 'invoices2'), { recursive: true });
    await writeFile(join(libraryRoot, 'loose.pdf'), 'not a directory');

    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    // Jobs and schedules live in pg-boss's own schema, which truncateAll leaves alone.
    await testPrisma().$executeRawUnsafe('TRUNCATE TABLE pgboss.job');
    await testPrisma().$executeRawUnsafe('DELETE FROM pgboss.schedule');
    app.emails.reset();
    seq += 1;
    adminCookie = await onboard(`libadmin${seq}@legere.local`);
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

  // A second, non-admin account so visibility can be observed from both sides.
  async function inviteUser(email: string): Promise<{ id: string; cookie: string }> {
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
    const cookie = cookieNamed(completed, 'sid');
    if (cookie === undefined) throw new Error('invited user has no session');
    return { id: expectData(completed, userDtoSchema).id, cookie };
  }

  const createLibrary = (body: Record<string, unknown>) =>
    api(app).post('/api/admin/libraries', body).set('Cookie', adminCookie);

  describe('creation and path validation', () => {
    it('creates a library, defaults to RESTRICTED, and enqueues the first scan', async () => {
      const res = await createLibrary({ name: 'Invoices', rootPath: 'invoices' });

      expect(res.status).toBe(201);
      const library = expectData(res, libraryAdminDtoSchema);
      expect(library).toMatchObject({
        name: 'Invoices',
        rootPath: 'invoices',
        enabled: true,
        // Fail-closed default (docs/03 §3.3.6, docs/08 §8.7).
        visibility: 'RESTRICTED',
        scanIntervalMinutes: 15,
        excludeGlobs: [],
        userIds: [],
      });

      // The first scan is queued together with the library (docs/05 §5.2).
      const jobs = await testPrisma().$queryRawUnsafe<{ name: string; data: unknown }[]>(
        "SELECT name, data FROM pgboss.job WHERE name = 'library-scan'",
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.data).toEqual({ libraryId: library.id });

      // …and the recurring sweep is registered. pg-boss keys schedules by queue name alone, so one
      // sweep serves every library and decides per library whether a scan is due.
      const schedules = await testPrisma().$queryRawUnsafe<{ cron: string }[]>(
        "SELECT cron FROM pgboss.schedule WHERE name = 'library-scan'",
      );
      expect(schedules).toHaveLength(1);
      expect(schedules[0]?.cron).toBe('* * * * *');
    });

    it('accepts the volume root itself', async () => {
      const res = await createLibrary({ name: 'Everything', rootPath: '' });
      expect(res.status).toBe(201);
      expect(expectData(res, libraryAdminDtoSchema).rootPath).toBe('');
    });

    it('rejects a path outside the volume, a missing one, and a file', async () => {
      for (const rootPath of ['../escape', '/etc', 'nope/missing', 'loose.pdf']) {
        const res = await createLibrary({ name: 'Bad', rootPath });
        expect([422], `rootPath=${rootPath}`).toContain(res.status);
        expect(expectError(res).code, `rootPath=${rootPath}`).toBe(
          rootPath === '../escape' || rootPath === '/etc'
            ? 'VALIDATION_FAILED'
            : 'LIBRARY_PATH_INVALID',
        );
      }
    });

    it('rejects a duplicate path and either direction of nesting', async () => {
      expect((await createLibrary({ name: 'Invoices', rootPath: 'invoices' })).status).toBe(201);

      const duplicate = await createLibrary({ name: 'Again', rootPath: 'invoices' });
      expect(duplicate.status).toBe(409);
      expect(expectError(duplicate).code).toBe('LIBRARY_PATH_CONFLICT');

      const child = await createLibrary({ name: 'Child', rootPath: 'invoices/2026' });
      expect(expectError(child).code).toBe('LIBRARY_PATH_CONFLICT');

      const root = await createLibrary({ name: 'Root', rootPath: '' });
      expect(expectError(root).code).toBe('LIBRARY_PATH_CONFLICT');

      // A sibling that merely shares a name prefix is fine.
      expect((await createLibrary({ name: 'Sibling', rootPath: 'invoices2' })).status).toBe(201);
    });

    it('allows reusing the path of a soft-deleted library', async () => {
      const first = expectData(
        await createLibrary({ name: 'Invoices', rootPath: 'invoices' }),
        libraryAdminDtoSchema,
      );
      await api(app).delete(`/api/admin/libraries/${first.id}`).set('Cookie', adminCookie);

      // Only *active* libraries constrain each other (docs/03 §3.3.6).
      expect((await createLibrary({ name: 'Invoices again', rootPath: 'invoices' })).status).toBe(
        201,
      );
    });
  });

  describe('path candidates', () => {
    it('browses directories inside the volume', async () => {
      const root = await api(app)
        .get('/api/admin/library-path-candidates')
        .set('Cookie', adminCookie);

      expect(root.status).toBe(200);
      const listing = expectData(root, pathCandidatesResponseSchema);
      expect(listing.path).toBe('');
      expect(listing.dirs.map((dir) => dir.name)).toEqual(
        expect.arrayContaining(['invoices', 'invoices2', 'receipts']),
      );
      // Files are not offered as library roots.
      expect(listing.dirs.map((dir) => dir.name)).not.toContain('loose.pdf');

      const nested = await api(app)
        .get('/api/admin/library-path-candidates?path=invoices')
        .set('Cookie', adminCookie);
      expect(expectData(nested, pathCandidatesResponseSchema).dirs).toEqual([{ name: '2026' }]);
    });

    it('refuses to browse outside the volume (🔒)', async () => {
      const traversal = await api(app)
        .get('/api/admin/library-path-candidates?path=../..')
        .set('Cookie', adminCookie);
      expect(traversal.status).toBe(422);

      const absolute = await api(app)
        .get('/api/admin/library-path-candidates?path=/etc')
        .set('Cookie', adminCookie);
      expect(absolute.status).toBe(422);
    });
  });

  describe('visibility', () => {
    it('hides a RESTRICTED library from a user without a grant and shows it once granted', async () => {
      const user = await inviteUser('viewer@legere.local');
      const library = expectData(
        await createLibrary({ name: 'Private', rootPath: 'invoices' }),
        libraryAdminDtoSchema,
      );

      const before = await api(app).get('/api/libraries').set('Cookie', user.cookie);
      expect(expectData(before, listLibrariesResponseSchema).items).toEqual([]);

      const granted = await api(app)
        .patch(`/api/admin/libraries/${library.id}`, { userIds: [user.id] })
        .set('Cookie', adminCookie);
      expect(expectData(granted, libraryAdminDtoSchema).userIds).toEqual([user.id]);

      const after = await api(app).get('/api/libraries').set('Cookie', user.cookie);
      expect(expectData(after, listLibrariesResponseSchema).items).toEqual([
        { id: library.id, name: 'Private' },
      ]);

      // Revoking the grant hides it again.
      await api(app)
        .patch(`/api/admin/libraries/${library.id}`, { userIds: [] })
        .set('Cookie', adminCookie);
      const revoked = await api(app).get('/api/libraries').set('Cookie', user.cookie);
      expect(expectData(revoked, listLibrariesResponseSchema).items).toEqual([]);
    });

    it('shows an ALL_USERS library to everyone, and every library to an admin', async () => {
      const user = await inviteUser('everyone@legere.local');
      await createLibrary({ name: 'Open', rootPath: 'receipts', visibility: 'ALL_USERS' });
      await createLibrary({ name: 'Closed', rootPath: 'invoices' });

      const asUser = await api(app).get('/api/libraries').set('Cookie', user.cookie);
      expect(
        expectData(asUser, listLibrariesResponseSchema).items.map((item) => item.name),
      ).toEqual(['Open']);

      const asAdmin = await api(app).get('/api/libraries').set('Cookie', adminCookie);
      expect(
        expectData(asAdmin, listLibrariesResponseSchema)
          .items.map((item) => item.name)
          .sort(),
      ).toEqual(['Closed', 'Open']);
    });

    it('hides a soft-deleted library from listings', async () => {
      const user = await inviteUser('deleted@legere.local');
      const library = expectData(
        await createLibrary({ name: 'Doomed', rootPath: 'receipts', visibility: 'ALL_USERS' }),
        libraryAdminDtoSchema,
      );

      const remove = await api(app)
        .delete(`/api/admin/libraries/${library.id}`)
        .set('Cookie', adminCookie);
      expect(expectData(remove, okResponseSchema)).toEqual({ ok: true });

      const asUser = await api(app).get('/api/libraries').set('Cookie', user.cookie);
      expect(expectData(asUser, listLibrariesResponseSchema).items).toEqual([]);

      const asAdmin = await api(app).get('/api/admin/libraries').set('Cookie', adminCookie);
      expect(expectData(asAdmin, listLibrariesAdminResponseSchema).items).toEqual([]);

      // The row itself is retained (ADR-015).
      const stored = await testPrisma().library.findFirstOrThrow({ where: { id: library.id } });
      expect(stored.deletedAt).not.toBeNull();

      // And it 404s individually.
      const detail = await api(app)
        .get(`/api/admin/libraries/${library.id}`)
        .set('Cookie', adminCookie);
      expect(detail.status).toBe(404);
      expect(expectError(detail).code).toBe('LIBRARY_NOT_FOUND');
    });
  });

  describe('updates', () => {
    it('updates settings and re-registers the schedule, but never the root path', async () => {
      const library = expectData(
        await createLibrary({ name: 'Invoices', rootPath: 'invoices' }),
        libraryAdminDtoSchema,
      );

      const res = await api(app)
        .patch(`/api/admin/libraries/${library.id}`, {
          name: 'Renamed',
          scanIntervalMinutes: 60,
          excludeGlobs: ['**/node_modules/**'],
          visibility: 'ALL_USERS',
          // rootPath is not part of the contract; sending it must not move the library.
          rootPath: 'receipts',
        })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(expectData(res, libraryAdminDtoSchema)).toMatchObject({
        name: 'Renamed',
        rootPath: 'invoices',
        scanIntervalMinutes: 60,
        excludeGlobs: ['**/node_modules/**'],
        visibility: 'ALL_USERS',
      });

      // The sweep is interval-agnostic: a changed interval needs no schedule change.
      const schedules = await testPrisma().$queryRawUnsafe<{ cron: string }[]>(
        "SELECT cron FROM pgboss.schedule WHERE name = 'library-scan'",
      );
      expect(schedules[0]?.cron).toBe('* * * * *');
    });

    it('drops the sweep once no enabled library remains', async () => {
      const library = expectData(
        await createLibrary({ name: 'Invoices', rootPath: 'invoices' }),
        libraryAdminDtoSchema,
      );

      await api(app)
        .patch(`/api/admin/libraries/${library.id}`, { enabled: false })
        .set('Cookie', adminCookie);

      const schedules = await testPrisma().$queryRawUnsafe<{ cron: string }[]>(
        "SELECT cron FROM pgboss.schedule WHERE name = 'library-scan'",
      );
      expect(schedules).toHaveLength(0);
    });

    it('rejects an empty patch and 404s an unknown library', async () => {
      const library = expectData(
        await createLibrary({ name: 'Invoices', rootPath: 'invoices' }),
        libraryAdminDtoSchema,
      );

      const empty = await api(app)
        .patch(`/api/admin/libraries/${library.id}`, {})
        .set('Cookie', adminCookie);
      expect(empty.status).toBe(422);

      const unknown = await api(app)
        .patch('/api/admin/libraries/11111111-1111-4111-8111-111111111111', { name: 'x' })
        .set('Cookie', adminCookie);
      expect(unknown.status).toBe(404);
    });
  });

  describe('scans', () => {
    it('starts a scan, refuses a second while one runs, and journals it', async () => {
      const library = expectData(
        await createLibrary({ name: 'Invoices', rootPath: 'invoices' }),
        libraryAdminDtoSchema,
      );

      await takeQueuedScans();

      const first = await api(app)
        .post(`/api/admin/libraries/${library.id}/scan`)
        .set('Cookie', adminCookie);
      expect(first.status).toBe(200);
      const started = expectData(first, triggerScanResponseSchema);
      expect('scanRunId' in started).toBe(true);

      // One scan per library at a time (docs/05 §5.2).
      const second = await api(app)
        .post(`/api/admin/libraries/${library.id}/scan`)
        .set('Cookie', adminCookie);
      expect(expectData(second, triggerScanResponseSchema)).toEqual({ alreadyRunning: true });

      const journal = await api(app)
        .get(`/api/admin/libraries/${library.id}/scans`)
        .set('Cookie', adminCookie);
      const runs = expectData(journal, listScanRunsResponseSchema);
      expect(runs.items).toHaveLength(1);
      expect(runs.items[0]).toMatchObject({ status: 'RUNNING', filesSeen: 0 });
    });

    it('answers alreadyRunning, and journals nothing, when a scan is already queued', async () => {
      // Creating a library queues its first scan; asking for another one collapses into it. 🔒 The
      // journal must stay empty — a RUNNING row with no job behind it would block this library's
      // scans forever through scan_runs_running_uq (docs/04 §4.3).
      const library = expectData(
        await createLibrary({ name: 'Invoices', rootPath: 'invoices' }),
        libraryAdminDtoSchema,
      );

      const res = await api(app)
        .post(`/api/admin/libraries/${library.id}/scan`)
        .set('Cookie', adminCookie);

      expect(expectData(res, triggerScanResponseSchema)).toEqual({ alreadyRunning: true });
      const journal = await api(app)
        .get(`/api/admin/libraries/${library.id}/scans`)
        .set('Cookie', adminCookie);
      expect(expectData(journal, listScanRunsResponseSchema).items).toHaveLength(0);
    });

    it('404s a scan trigger for an unknown library', async () => {
      const res = await api(app)
        .post('/api/admin/libraries/11111111-1111-4111-8111-111111111111/scan')
        .set('Cookie', adminCookie);
      expect(res.status).toBe(404);
      expect(expectError(res).code).toBe('LIBRARY_NOT_FOUND');
    });
  });

  describe('admin listing', () => {
    it('reports counters and the last scan', async () => {
      const library = expectData(
        await createLibrary({ name: 'Invoices', rootPath: 'invoices' }),
        libraryAdminDtoSchema,
      );
      await takeQueuedScans();
      await api(app).post(`/api/admin/libraries/${library.id}/scan`).set('Cookie', adminCookie);

      const res = await api(app).get('/api/admin/libraries').set('Cookie', adminCookie);
      const items = expectData(res, listLibrariesAdminResponseSchema).items;

      expect(items).toHaveLength(1);
      // No files discovered yet — the scan handler lands in M3.4.
      expect(items[0]?.counters).toEqual({ files: 0, documents: 0, missing: 0 });
      expect(items[0]?.lastScan).toMatchObject({ status: 'RUNNING' });
    });
  });

  describe('authorization', () => {
    it('refuses every admin library route to a non-admin, and anonymous callers', async () => {
      const user = await inviteUser('nosy@legere.local');

      const asUser = await api(app).get('/api/admin/libraries').set('Cookie', user.cookie);
      expect(asUser.status).toBe(403);
      expect(expectError(asUser).code).toBe('FORBIDDEN');

      const create = await api(app)
        .post('/api/admin/libraries', { name: 'Nope', rootPath: 'invoices' })
        .set('Cookie', user.cookie);
      expect(create.status).toBe(403);

      const candidates = await api(app)
        .get('/api/admin/library-path-candidates')
        .set('Cookie', user.cookie);
      expect(candidates.status).toBe(403);

      const anonymous = await api(app).get('/api/admin/libraries');
      expect(anonymous.status).toBe(401);

      // The user-facing list still requires a session.
      const anonymousList = await api(app).get('/api/libraries');
      expect(anonymousList.status).toBe(401);
    });
  });
});
