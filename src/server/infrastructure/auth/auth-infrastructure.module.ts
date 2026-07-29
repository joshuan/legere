import { Global, Module } from '@nestjs/common';
import { CaptchaVerifier } from '../../application/ports/captcha-verifier';
import { Clock } from '../../application/ports/clock';
import { EmailSender } from '../../application/ports/email-sender';
import { PasswordHasher } from '../../application/ports/password-hasher';
import { SessionTokens } from '../../application/ports/session-tokens';
import { AppConfig } from '../config/app-config';
import { LogEmailSender } from '../email/log-email-sender';
import { SmtpEmailSender } from '../email/smtp-email-sender';
import { Argon2PasswordHasher } from './argon2-password-hasher';
import { CryptoSessionTokens } from './crypto-session-tokens';
import { SystemClock } from './system-clock';
import { TurnstileCaptchaVerifier } from './turnstile-captcha-verifier';

// Binds the auth-related application ports to their implementations (docs/06 §6.5).
// EmailSender is chosen at boot: SMTP when configured, otherwise the log fallback (docs/12 §12.4).
@Global()
@Module({
  providers: [
    LogEmailSender,
    { provide: Clock, useClass: SystemClock },
    { provide: PasswordHasher, useClass: Argon2PasswordHasher },
    { provide: SessionTokens, useClass: CryptoSessionTokens },
    { provide: CaptchaVerifier, useClass: TurnstileCaptchaVerifier },
    {
      provide: EmailSender,
      useFactory: (config: AppConfig, logSender: LogEmailSender): EmailSender =>
        config.get('SMTP_HOST') === '' ? logSender : new SmtpEmailSender(config),
      inject: [AppConfig, LogEmailSender],
    },
  ],
  exports: [Clock, PasswordHasher, SessionTokens, CaptchaVerifier, EmailSender],
})
export class AuthInfrastructureModule {}
