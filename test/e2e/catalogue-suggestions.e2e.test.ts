import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import {
  subjectKindDtoSchema,
  subjectKindMergePreviewResponseSchema,
  subjectKindMergeSuggestionsResponseSchema,
} from '../../src/shared/contracts/subject-kinds';
import {
  subjectDtoSchema,
  subjectMergePreviewResponseSchema,
  subjectMergeSuggestionsResponseSchema,
} from '../../src/shared/contracts/subjects';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

// 🔒 The suite pins the analyst to "not configured" whatever the developer's own environment says
// (docs/05 §5.6c) — no test may ever reach a real provider.
process.env.CLASSIFIER_API_BASE_URL = '';
process.env.CLASSIFIER_MODEL = '';
process.env.EMBEDDINGS_API_BASE_URL = '';

const PASSWORD = 'a-decent-passphrase';

// The subjects and kinds suggestion endpoints (docs/07 §7.3, docs/05 §5.6c), on the people
// endpoints' terms: what e2e proves is the door and the degradation.
describe('Catalogue suggestions (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let userCookie: string;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('DELETE FROM pgboss.job');
    app.emails.reset();
    seq += 1;
    adminCookie = await onboard(`suggestkindadmin${seq}@legere.local`);
    userCookie = await inviteUser(`suggestkindreader${seq}@legere.local`);
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
      inviteToken: token,
      email,
      code: app.emails.lastCodeFor(email),
    });
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
    const sid = cookieNamed(completed, 'sid');
    if (sid === undefined) throw new Error('invited user has no session');
    return sid;
  }

  async function givenKind(name: string): Promise<string> {
    const created = await api(app).post('/api/subject-kinds', { name }).set('Cookie', adminCookie);
    return expectData(created, subjectKindDtoSchema).id;
  }

  it('refuses every suggestion endpoint to a non-admin', async () => {
    const kindA = await givenKind('car');
    const kindB = await givenKind('автомобиль');

    for (const request of [
      api(app).get('/api/admin/subjects/merge-suggestions'),
      api(app).post('/api/admin/subjects/merge-preview', { ids: [kindA, kindB] }),
      api(app).get('/api/admin/subject-kinds/merge-suggestions'),
      api(app).post('/api/admin/subject-kinds/merge-preview', { ids: [kindA, kindB] }),
    ]) {
      const refused = await request.set('Cookie', userCookie);
      expect(refused.status).toBe(403);
      expect(expectError(refused).code).toBe('FORBIDDEN');
    }
  });

  it('answers UNCONFIGURED on subjects and kinds alike, never an error', async () => {
    const kind = await givenKind('жильё');
    await api(app)
      .post('/api/subjects', { kindId: kind, name: 'Красноармейская 11а' })
      .set('Cookie', adminCookie);

    const subjects = await api(app)
      .get('/api/admin/subjects/merge-suggestions')
      .set('Cookie', adminCookie);
    expect(subjects.status).toBe(200);
    expect(expectData(subjects, subjectMergeSuggestionsResponseSchema)).toEqual({
      state: 'UNCONFIGURED',
      // No reading, so nothing to date (docs/07 §7.3).
      computedAt: null,
      groups: [],
      placeholders: [],
    });

    const kinds = await api(app)
      .get('/api/admin/subject-kinds/merge-suggestions')
      .set('Cookie', adminCookie);
    expect(kinds.status).toBe(200);
    expect(expectData(kinds, subjectKindMergeSuggestionsResponseSchema)).toEqual({
      state: 'UNCONFIGURED',
      computedAt: null,
      groups: [],
    });
  });

  it('previews as unavailable with no analyst, and refuses a dead id', async () => {
    const kind = await givenKind('жильё');
    const first = expectData(
      await api(app)
        .post('/api/subjects', { kindId: kind, name: 'Красноармейская 11а' })
        .set('Cookie', adminCookie),
      subjectDtoSchema,
    ).id;
    const second = expectData(
      await api(app)
        .post('/api/subjects', { kindId: kind, name: 'ул. Красноармейская, 11а' })
        .set('Cookie', adminCookie),
      subjectDtoSchema,
    ).id;

    const preview = await api(app)
      .post('/api/admin/subjects/merge-preview', { ids: [first, second] })
      .set('Cookie', adminCookie);
    expect(preview.status).toBe(200);
    expect(expectData(preview, subjectMergePreviewResponseSchema)).toEqual({
      available: false,
      name: null,
      kindId: null,
      aka: null,
      note: null,
    });

    const dead = await api(app)
      .post('/api/admin/subjects/merge-preview', {
        ids: [first, '99999999-9999-4999-8999-999999999999'],
      })
      .set('Cookie', adminCookie);
    expect(dead.status).toBe(404);
    expect(expectError(dead).code).toBe('SUBJECT_NOT_FOUND');

    const secondKind = await givenKind('Жильё вторичное');
    const kindPreview = await api(app)
      .post('/api/admin/subject-kinds/merge-preview', { ids: [kind, secondKind] })
      .set('Cookie', adminCookie);
    expect(kindPreview.status).toBe(200);
    expect(expectData(kindPreview, subjectKindMergePreviewResponseSchema)).toEqual({
      available: false,
      name: null,
      aka: null,
      note: null,
    });

    const deadKind = await api(app)
      .post('/api/admin/subject-kinds/merge-preview', {
        ids: [kind, '99999999-9999-4999-8999-999999999999'],
      })
      .set('Cookie', adminCookie);
    expect(deadKind.status).toBe(404);
    expect(expectError(deadKind).code).toBe('SUBJECT_KIND_NOT_FOUND');
  });
});
