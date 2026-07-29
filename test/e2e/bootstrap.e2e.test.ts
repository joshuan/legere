import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthDataSchema } from '../../src/shared/contracts/common';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma } from '../helpers/db';
import { expectData, expectError } from '../helpers/http';

// Exercises the one-process wiring (docs/02 §2.2): the /api dispatcher, the terminal JSON 404, and
// the health endpoint against a real database and a started queue.
describe('API bootstrap (e2e)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  it('GET /api/health reports every component, checked for real', async () => {
    const res = await api(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(expectData(res, healthDataSchema)).toEqual({ status: 'ok', db: 'ok', queue: 'ok' });
  });

  it('unknown /api route returns a JSON NOT_FOUND envelope, never HTML', async () => {
    const res = await api(app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(expectError(res)).toEqual({
      code: 'NOT_FOUND',
      message: 'Unknown API route',
      details: null,
    });
  });

  it('non-api routes are dispatched to the Next handler, not Nest', async () => {
    const res = await api(app).get('/some-page');

    expect(res.body).toEqual({ next: true });
  });
});
