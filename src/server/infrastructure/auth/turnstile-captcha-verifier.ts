import { Injectable } from '@nestjs/common';
import { TurnstileCaptchaVerifier as SharedTurnstileCaptchaVerifier } from '@joshuan/auth-adapters';
import { CaptchaVerifier } from '../../application/ports/captcha-verifier';
import { AppConfig } from '../config/app-config';

@Injectable()
export class TurnstileCaptchaVerifier extends CaptchaVerifier {
  private readonly shared: SharedTurnstileCaptchaVerifier;

  constructor(config: AppConfig) {
    super();
    this.shared = new SharedTurnstileCaptchaVerifier({
      secretKey: config.get('TURNSTILE_SECRET_KEY'),
    });
  }

  get isConfigured(): boolean {
    return this.shared.configured;
  }

  verify(token: string | undefined, ip: string | undefined): Promise<boolean> {
    return this.shared.verify(token, ip);
  }
}
