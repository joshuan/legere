import type { CookieOptions } from 'express';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../infrastructure/config/app-config';
import { clearSessionCookie, setSessionCookie, type CookieSink } from './session-cookie';

type SentCookie = { name: string; value: string; options: CookieOptions };

// Records what express would have been asked to send, without an express app. The helpers touch
// exactly these two methods, so a Pick of Response types the double honestly — no assertions.
class CookieRecorder implements CookieSink {
  readonly cookies: SentCookie[] = [];

  cookie(name: string, value: string, options?: CookieOptions): this {
    this.cookies.push({ name, value, options: options ?? {} });
    return this;
  }

  clearCookie(name: string, options?: CookieOptions): this {
    this.cookies.push({ name, value: '', options: options ?? {} });
    return this;
  }
}

function recorder(): { cookies: SentCookie[]; res: CookieRecorder } {
  const res = new CookieRecorder();
  return { cookies: res.cookies, res };
}

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
    APP_BASE_URL: 'http://localhost:3000',
    AUTH_SECRET: 'test-secret-minimum-32-characters!!',
    S3_ACCESS_KEY_ID: 'test-access-key',
    S3_SECRET_ACCESS_KEY: 'test-secret-key',
    ...overrides,
  });
}

// The attributes of docs/08 §8.2.
describe('setSessionCookie', () => {
  it('is HttpOnly, SameSite=Lax and scoped to the whole site', () => {
    const { cookies, res } = recorder();

    setSessionCookie(res, config(), 'token');

    expect(cookies[0]?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(cookies[0]?.value).toBe('token');
  });

  it('marks the cookie Secure when the app is served over https', () => {
    const { cookies, res } = recorder();

    setSessionCookie(res, config({ APP_BASE_URL: 'https://legere.example.com' }), 'token');

    expect(cookies[0]?.options.secure).toBe(true);
  });

  it('leaves it unset over plain http, or the browser would drop the session entirely', () => {
    const { cookies, res } = recorder();

    // 🔒 A self-hosted instance on a LAN address must still be able to hold a session; NODE_ENV has
    // no say in it (docs/08 §8.2).
    setSessionCookie(
      res,
      config({ APP_BASE_URL: 'http://192.168.1.10:3000', NODE_ENV: 'production' }),
      'token',
    );

    expect(cookies[0]?.options.secure).toBe(false);
  });

  it('expires with SESSION_TTL_DAYS and carries COOKIE_DOMAIN only when one is set', () => {
    const plain = recorder();
    setSessionCookie(plain.res, config({ SESSION_TTL_DAYS: '7' }), 'token');
    expect(plain.cookies[0]?.options.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
    expect(plain.cookies[0]?.options.domain).toBeUndefined();

    const scoped = recorder();
    setSessionCookie(scoped.res, config({ COOKIE_DOMAIN: 'legere.example.com' }), 'token');
    expect(scoped.cookies[0]?.options.domain).toBe('legere.example.com');
  });
});

describe('clearSessionCookie', () => {
  it('clears with the same attributes it was set with, or the browser keeps it', () => {
    const { cookies, res } = recorder();

    clearSessionCookie(res, config({ APP_BASE_URL: 'https://legere.example.com' }));

    expect(cookies[0]?.name).toBe('sid');
    expect(cookies[0]?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true });
  });
});
