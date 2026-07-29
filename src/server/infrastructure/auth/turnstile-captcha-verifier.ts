import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CaptchaVerifier } from '../../application/ports/captcha-verifier';
import { AppConfig } from '../config/app-config';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

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
      const response = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body });
      if (!response.ok) return false;
      const parsed = turnstileResponseSchema.safeParse(await response.json());
      return parsed.success && parsed.data.success;
    } catch {
      // Fail closed: an unreachable verifier must not become a bypass.
      return false;
    }
  }
}
