import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CatalogueAnalyst,
  type CatalogueName,
  type CatalogueRow,
  type CatalogueSuggestions,
  type MergePreview,
} from '../../src/server/application/ports/catalogue-analyst';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import { peopleMergeSuggestionsResponseSchema } from '../../src/shared/contracts/people';
import {
  subjectKindDtoSchema,
  subjectKindMergeSuggestionsResponseSchema,
} from '../../src/shared/contracts/subject-kinds';
import { subjectMergeSuggestionsResponseSchema } from '../../src/shared/contracts/subjects';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData } from '../helpers/http';

process.env.CLASSIFIER_API_BASE_URL = '';
process.env.CLASSIFIER_MODEL = '';
process.env.EMBEDDINGS_API_BASE_URL = '';

const PASSWORD = 'a-decent-passphrase';

// An analyst that exists and cannot answer — the live instance's own failure, where the provider
// answered 500 after thirteen seconds (docs/05 §5.6c). Nothing here reaches a network.
class BrokenAnalyst extends CatalogueAnalyst {
  readonly asked: CatalogueName[] = [];

  get isConfigured(): boolean {
    return true;
  }

  suggestMerges(
    catalogue: CatalogueName,
    rows: readonly CatalogueRow[],
  ): Promise<CatalogueSuggestions> {
    void rows;
    this.asked.push(catalogue);
    return Promise.reject(
      new Error('Catalogue analyst request failed with 500: tool call denied by policy'),
    );
  }

  previewMerge(
    catalogue: CatalogueName,
    rows: readonly CatalogueRow[],
  ): Promise<MergePreview | null> {
    void catalogue;
    void rows;
    return Promise.resolve(null);
  }
}

// 🔒 M52.1: the third state on the wire. What e2e proves is that a provider failure reaches the
// screen as itself — `200` with `UNAVAILABLE` — rather than as the empty groups that made a dead
// analyst and a clean catalogue the same picture.
describe('Catalogue suggestions when the analyst cannot be asked (e2e)', () => {
  let app: TestApp;
  let analyst: BrokenAnalyst;
  let adminCookie: string;
  let seq = 0;

  beforeAll(async () => {
    analyst = new BrokenAnalyst();
    app = await createTestApp({ analyst });
  });

  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('TRUNCATE TABLE pgboss.job');
    app.emails.reset();
    analyst.asked.length = 0;
    seq += 1;
    adminCookie = await onboard(`brokenanalyst${seq}@legere.local`);
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

  async function seedCatalogues(): Promise<void> {
    await api(app).post('/api/people', { name: 'Marija Petrović' }).set('Cookie', adminCookie);
    await api(app).post('/api/people', { name: 'Marija Petrovic' }).set('Cookie', adminCookie);
    const kind = expectData(
      await api(app).post('/api/subject-kinds', { name: 'жильё' }).set('Cookie', adminCookie),
      subjectKindDtoSchema,
    ).id;
    await api(app).post('/api/subject-kinds', { name: 'Жильё' }).set('Cookie', adminCookie);
    await api(app)
      .post('/api/subjects', { kindId: kind, name: 'Красноармейская 11а' })
      .set('Cookie', adminCookie);
    await api(app)
      .post('/api/subjects', { kindId: kind, name: 'ул. Красноармейская, 11а' })
      .set('Cookie', adminCookie);
  }

  it('answers UNAVAILABLE on all three endpoints, never an error and never an empty answer', async () => {
    await seedCatalogues();

    const people = await api(app)
      .get('/api/admin/people/merge-suggestions')
      .set('Cookie', adminCookie);
    expect(people.status).toBe(200);
    expect(expectData(people, peopleMergeSuggestionsResponseSchema)).toEqual({
      state: 'UNAVAILABLE',
      // A reading that failed is not one the screen may date (docs/07 §7.3).
      computedAt: null,
      groups: [],
    });

    const subjects = await api(app)
      .get('/api/admin/subjects/merge-suggestions')
      .set('Cookie', adminCookie);
    expect(subjects.status).toBe(200);
    expect(expectData(subjects, subjectMergeSuggestionsResponseSchema)).toEqual({
      state: 'UNAVAILABLE',
      computedAt: null,
      groups: [],
      placeholders: [],
    });

    const kinds = await api(app)
      .get('/api/admin/subject-kinds/merge-suggestions')
      .set('Cookie', adminCookie);
    expect(kinds.status).toBe(200);
    expect(expectData(kinds, subjectKindMergeSuggestionsResponseSchema)).toEqual({
      state: 'UNAVAILABLE',
      computedAt: null,
      groups: [],
    });

    expect(analyst.asked).toEqual(['people', 'subjects', 'subject-kinds']);
  });

  it('asks again on the next request, because a refusal is never remembered', async () => {
    await seedCatalogues();

    await api(app).get('/api/admin/people/merge-suggestions').set('Cookie', adminCookie);
    const again = await api(app)
      .get('/api/admin/people/merge-suggestions')
      .set('Cookie', adminCookie);

    // An outage is not a verdict (docs/05 §5.4e): nothing about the failure was cached.
    expect(expectData(again, peopleMergeSuggestionsResponseSchema).state).toBe('UNAVAILABLE');
    expect(analyst.asked).toEqual(['people', 'people']);
  });
});
