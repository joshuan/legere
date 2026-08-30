import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import {
  peopleMergePreviewResponseSchema,
  peopleMergeSuggestionsResponseSchema,
  personDtoSchema,
} from '../../src/shared/contracts/people';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

// 🔒 The suite pins the analyst to "not configured" whatever the developer's own environment says:
// with these empty, `serviceEndpoint('classifier')` has nothing to fall back to either, and no test
// can ever reach a real provider (docs/05 §5.6c).
process.env.CLASSIFIER_API_BASE_URL = '';
process.env.CLASSIFIER_MODEL = '';
process.env.EMBEDDINGS_API_BASE_URL = '';

const PASSWORD = 'a-decent-passphrase';

// The merge-suggestion endpoints (docs/07 §7.3, docs/05 §5.6c): admin-only, degrading to an honest
// "not configured" rather than an error. The analyst's answers themselves are unit-tested — what
// e2e proves is the door and the degradation.
describe('People merge suggestions (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let userCookie: string;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('TRUNCATE TABLE pgboss.job');
    app.emails.reset();
    seq += 1;
    adminCookie = await onboard(`suggestadmin${seq}@legere.local`);
    userCookie = await inviteUser(`suggestreader${seq}@legere.local`);
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

  async function givenPerson(name: string): Promise<string> {
    const created = await api(app).post('/api/people', { name }).set('Cookie', adminCookie);
    return expectData(created, personDtoSchema).id;
  }

  it('refuses both endpoints to a non-admin', async () => {
    const suggestions = await api(app)
      .get('/api/admin/people/merge-suggestions')
      .set('Cookie', userCookie);
    expect(suggestions.status).toBe(403);
    expect(expectError(suggestions).code).toBe('FORBIDDEN');

    const first = await givenPerson('Marija Petrović');
    const second = await givenPerson('Marija Petrovic');
    const preview = await api(app)
      .post('/api/admin/people/merge-preview', { ids: [first, second] })
      .set('Cookie', userCookie);
    expect(preview.status).toBe(403);
    expect(expectError(preview).code).toBe('FORBIDDEN');
  });

  it('answers UNCONFIGURED with no analyst, never an error', async () => {
    await givenPerson('Marija Petrović');
    await givenPerson('Marija Petrovic');

    const response = await api(app)
      .get('/api/admin/people/merge-suggestions')
      .set('Cookie', adminCookie);
    expect(response.status).toBe(200);
    expect(expectData(response, peopleMergeSuggestionsResponseSchema)).toEqual({
      state: 'UNCONFIGURED',
      // No reading, so nothing to date (docs/07 §7.3).
      computedAt: null,
      groups: [],
    });
  });

  it('previews as unavailable with no analyst, so the dialog keeps its raw prefill', async () => {
    const first = await givenPerson('Marija Petrović');
    const second = await givenPerson('Marija Petrovic');

    const response = await api(app)
      .post('/api/admin/people/merge-preview', { ids: [first, second] })
      .set('Cookie', adminCookie);
    expect(response.status).toBe(200);
    expect(expectData(response, peopleMergePreviewResponseSchema)).toEqual({
      available: false,
      name: null,
      aka: null,
      note: null,
    });
  });

  it('refuses a preview naming somebody who is not a living person', async () => {
    const first = await givenPerson('Marija Petrović');

    const response = await api(app)
      .post('/api/admin/people/merge-preview', {
        ids: [first, '99999999-9999-4999-8999-999999999999'],
      })
      .set('Cookie', adminCookie);
    expect(response.status).toBe(404);
    expect(expectError(response).code).toBe('PERSON_NOT_FOUND');
  });
});
