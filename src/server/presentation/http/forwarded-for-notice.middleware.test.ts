import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { forwardedForNotice } from './forwarded-for-notice.middleware';

// 🔒 docs/12 §12.8. What an unset `TRUST_PROXY` costs grew when the throttle key became one budget
// per caller (M47.16): behind a proxy every anonymous caller is the same `req.ip`, so they share one
// 20-per-60-second `auth` allowance — and the sign-in page spends from it on every load, through
// `GET /api/auth/onboarding`. The misconfiguration is invisible at boot and visible on the first
// forwarded request, which is where this says so.
//
// A real Express instance, like its neighbour: the middleware sits in front of every route, and
// "it lets the request through" is half of what is being tested.
function appWith(warn: (message: string) => void): Express {
  const app = express();
  app.use(forwardedForNotice(warn));
  app.get('/api/auth/onboarding', (_req, res) => {
    res.json({ data: { needsFirstAdmin: false } });
  });
  return app;
}

describe('forwardedForNotice', () => {
  const onboarding = (app: Express) => request(app).get('/api/auth/onboarding');

  it('says what the shared budget costs the first time a forwarded request arrives', async () => {
    const warn = vi.fn();

    const response = await onboarding(appWith(warn)).set('X-Forwarded-For', '203.0.113.7');

    expect(response.status).toBe(200);
    expect(warn).toHaveBeenCalledOnce();
    const said = String(warn.mock.calls[0]?.[0]);
    expect(said).toMatch(/TRUST_PROXY is empty/);
    expect(said).toMatch(/one 20-per-60-second auth budget/);
    expect(said).toMatch(/docs\/12 §12\.8/);
  });

  // 🔒 The header is written by whoever sent the request, so anybody can produce this line. Once per
  // process is what keeps that from being a way to fill an operator's log — and the sentence is
  // two-sided on purpose, because "set TRUST_PROXY" on a directly published instance is an attacker
  // asking for the per-IP limits to be switched off (SEC-05).
  it('says it once per process, however many forwarded requests arrive', async () => {
    const warn = vi.fn();
    const app = appWith(warn);

    await onboarding(app).set('X-Forwarded-For', '203.0.113.7');
    await onboarding(app).set('X-Forwarded-For', '198.51.100.4');
    await onboarding(app).set('X-Forwarded-For', '203.0.113.7, 10.0.0.1');

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/must stay empty/);
  });

  it('stays quiet on an instance nothing is forwarding to, which is the shipped one', async () => {
    const warn = vi.fn();

    const response = await onboarding(appWith(warn));

    expect(response.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });
});
