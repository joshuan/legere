// CAPTCHA verification for login and register/start (docs/06 §6.3.3, docs/08 §8.4).
// When keys are unset the implementation is a no-op that accepts everything (dev default).
export abstract class CaptchaVerifier {
  abstract verify(token: string | undefined, ip: string | undefined): Promise<boolean>;

  // False when the feature is unconfigured, so callers can skip requiring a token at all.
  abstract get isConfigured(): boolean;
}
