import { afterEach, describe, expect, it, vi } from 'vitest';
import { endlessBody, neverAnswers, stubTimeouts } from '../../../../test/helpers/outbound';
import { loadConfig } from '../config/app-config';
import { TurnstileCaptchaVerifier } from './turnstile-captcha-verifier';

const BASE_ENV = {
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
  AUTH_SECRET: 'x'.repeat(32),
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
};

const verifierWith = (secret: string): TurnstileCaptchaVerifier =>
  new TurnstileCaptchaVerifier(loadConfig({ ...BASE_ENV, TURNSTILE_SECRET_KEY: secret }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TurnstileCaptchaVerifier (keys unset)', () => {
  it('reports itself unconfigured and accepts everything without any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const verifier = verifierWith('');

    expect(verifier.isConfigured).toBe(false);
    expect(await verifier.verify(undefined, undefined)).toBe(true);
    expect(await verifier.verify('anything', '203.0.113.1')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('TurnstileCaptchaVerifier (configured)', () => {
  it('accepts a token Cloudflare confirms, forwarding the secret and the caller IP', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true })));

    expect(await verifierWith('secret-key').verify('token-abc', '203.0.113.1')).toBe(true);

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const body = init?.body;
    if (!(body instanceof URLSearchParams)) throw new Error('expected a form-encoded body');
    expect(body.get('secret')).toBe('secret-key');
    expect(body.get('response')).toBe('token-abc');
    expect(body.get('remoteip')).toBe('203.0.113.1');
  });

  it('rejects a token Cloudflare denies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false })),
    );
    expect(await verifierWith('secret-key').verify('bad-token', undefined)).toBe(false);
  });

  it('rejects a missing token without calling Cloudflare', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await verifierWith('secret-key').verify(undefined, undefined)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed when the verification endpoint errors or is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    expect(await verifierWith('secret-key').verify('token', undefined)).toBe(false);

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    expect(await verifierWith('secret-key').verify('token', undefined)).toBe(false);
  });

  // 🔒 SEC-17, and the one call of the set that sits on the login request path: without a bound, a
  // hung Cloudflare holds an HTTP handler of the single process that is also the whole product.
  it('gives up in seconds on a verifier that answers nothing, and still fails closed', async () => {
    const timeouts = stubTimeouts();
    neverAnswers();

    const call = verifierWith('secret-key').verify('token', undefined);
    // Without the signal there is nothing to fire: the login request would wait here.
    timeouts.expire();

    expect(await call).toBe(false);
    expect(timeouts.requested()).toEqual([5_000]);
  });

  it('fails closed on a verifier that answers without stopping', async () => {
    const { response, produced } = endlessBody();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    expect(await verifierWith('secret-key').verify('token', undefined)).toBe(false);
    // Refused at the first chunk past 64 KiB rather than read into the request handler's memory.
    expect(produced()).toBeLessThan(4);
  });
});
