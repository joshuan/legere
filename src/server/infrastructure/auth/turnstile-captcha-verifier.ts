import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { readBoundedJson } from '../../application/ports/binary-source';
import { CaptchaVerifier } from '../../application/ports/captcha-verifier';
import { AppConfig } from '../config/app-config';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// 🔒 This one call sits on the login request path, so a hung Cloudflare holds an HTTP handler of the
// single process that is also the whole product (docs/02 ADR-002) — and undici's 300 s backstop,
// which a slow drip defeats anyway, is five minutes of that. Turnstile answers a siteverify in
// milliseconds; five seconds is already an outage on their side, and one the person logging in
// should be told about rather than made to wait through. The catch below then does what an
// unreachable verifier has always done here: refuse (docs/08 §8.4).
const TIMEOUT_MS = 5_000;

// 🔒 And how much may come back: the answer is a handful of short fields. Bounded because a redirect
// or a captive portal answering in Cloudflare's place is not obliged to be brief.
const MAX_ANSWER_BYTES = 64 * 1024;

// Only the fields we act on; Turnstile returns more.
const turnstileResponseSchema = z.object({ success: z.boolean() });

// Cloudflare Turnstile verification (docs/08 §8.4). When TURNSTILE_SECRET_KEY is unset the verifier
// is a no-op that accepts everything, so dev and unconfigured instances keep working.
@Injectable()
export class TurnstileCaptchaVerifier extends CaptchaVerifier {
  private readonly secretKey: string;

  constructor(config: AppConfig) {
    super();
    this.secretKey = config.get('TURNSTILE_SECRET_KEY');
  }

  get isConfigured(): boolean {
    return this.secretKey !== '';
  }

  async verify(token: string | undefined, ip: string | undefined): Promise<boolean> {
    if (!this.isConfigured) return true;
    if (token === undefined || token === '') return false;

    const body = new URLSearchParams({ secret: this.secretKey, response: token });
    if (ip !== undefined && ip !== '') body.set('remoteip', ip);

    try {
      const response = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const parsed = turnstileResponseSchema.safeParse(
        await readBoundedJson(response, MAX_ANSWER_BYTES),
      );
      return parsed.success && parsed.data.success;
    } catch {
      // Fail closed: an unreachable, wedged or over-talkative verifier must not become a bypass.
      return false;
    }
  }
}
