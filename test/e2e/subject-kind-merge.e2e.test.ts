import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import {
  listSubjectKindsResponseSchema,
  subjectKindDtoSchema,
} from '../../src/shared/contracts/subject-kinds';
import { listSubjectsResponseSchema, subjectDtoSchema } from '../../src/shared/contracts/subjects';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// The kinds merge (docs/03 §3.3.20a, docs/07 §7.3): shelves fold, the things they both held fold
// with them, and no document loses what it named.
describe('Subject kind merge (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('TRUNCATE TABLE pgboss.job');
    app.emails.reset();
    seq += 1;
    adminCookie = await onboard(`kindmergeadmin${seq}@legere.local`);
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

  async function givenKind(name: string): Promise<string> {
    const created = await api(app).post('/api/subject-kinds', { name }).set('Cookie', adminCookie);
    return expectData(created, subjectKindDtoSchema).id;
  }

  async function givenThing(kindId: string, name: string): Promise<string> {
    const created = await api(app)
      .post('/api/subjects', { kindId, name })
      .set('Cookie', adminCookie);
    return expectData(created, subjectDtoSchema).id;
  }

  it('folds two kinds into one, and the things they both held with them', async () => {
    const car = await givenKind('car');
    const avto = await givenKind('автомобиль');
    const lacettiCar = await givenThing(car, 'CHEVROLET LACETTI');
    // 🔒 The same car in another case under the other shelf: the fold is what says they are one
    // (docs/03 §3.3.19).
    await givenThing(avto, 'Chevrolet Lacetti');
    await givenThing(avto, 'ВАЗ 2107');

    const merged = await api(app)
      .post('/api/admin/subject-kinds/merge', { ids: [car, avto], name: 'автомобиль' })
      .set('Cookie', adminCookie);
    expect(merged.status).toBe(201);
    const survivor = expectData(merged, subjectKindDtoSchema);
    expect(survivor.id).toBe(car);
    expect(survivor.name).toBe('автомобиль');
    // Two things now, not three: the Lacetti folded.
    expect(survivor.subjectCount).toBe(2);

    const kinds = expectData(
      await api(app).get('/api/subject-kinds').set('Cookie', adminCookie),
      listSubjectKindsResponseSchema,
    );
    expect(kinds.items.map((kind) => kind.name)).toEqual(['автомобиль']);

    // Ordered by name explicitly: since M56.3 the catalogue opens on `lastDocumentAt desc`, which
    // says nothing about rows no document names (docs/07 §7.3).
    const subjects = expectData(
      await api(app).get('/api/subjects?sort=name&order=asc').set('Cookie', adminCookie),
      listSubjectsResponseSchema,
    );
    expect(subjects.items.map((subject) => [subject.kind, subject.name])).toEqual([
      ['автомобиль', 'CHEVROLET LACETTI'],
      ['автомобиль', 'ВАЗ 2107'],
    ]);
    expect(subjects.items.find((subject) => subject.name === 'CHEVROLET LACETTI')?.id).toBe(
      lacettiCar,
    );
  });

  it('refuses a survivor name that belongs to a kind outside the merge', async () => {
    const car = await givenKind('car');
    const avto = await givenKind('автомобиль');
    await givenKind('жильё');

    const refused = await api(app)
      .post('/api/admin/subject-kinds/merge', { ids: [car, avto], name: 'ЖИЛЬЁ' })
      .set('Cookie', adminCookie);
    expect(refused.status).toBe(409);
    expect(expectError(refused).code).toBe('SUBJECT_KIND_EXISTS');
  });
});
