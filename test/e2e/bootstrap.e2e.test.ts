import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
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

  it('wraps success in { data } and failure in { error }, and nothing else (docs/07 §7.1)', async () => {
    // Parsed loosely on purpose: the contract schemas would strip extra keys, and extra keys are
    // exactly what this test is looking for.
    const anyObject = z.record(z.unknown());

    const ok = anyObject.parse((await api(app).get('/api/health')).body);
    expect(Object.keys(ok)).toEqual(['data']);

    const failed = z
      .object({ error: anyObject })
      .parse((await api(app).get('/api/does-not-exist')).body);
    expect(Object.keys(failed)).toEqual(['error']);
    // All three keys, always: `details` is null rather than absent (docs/07 §7.1).
    expect(Object.keys(failed.error).sort()).toEqual(['code', 'details', 'message']);
    expect(failed.error.details).toBeNull();
  });

  it('non-api routes are dispatched to the Next handler, not Nest', async () => {
    const res = await api(app).get('/some-page');

    expect(res.body).toEqual({ next: true });
  });
});
