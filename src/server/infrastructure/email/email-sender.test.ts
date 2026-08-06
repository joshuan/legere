import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';
import { CaptchaVerifier } from '../../application/ports/captcha-verifier';
import { Clock } from '../../application/ports/clock';
import { EmailSender } from '../../application/ports/email-sender';
import { PasswordHasher } from '../../application/ports/password-hasher';
import { SessionTokens } from '../../application/ports/session-tokens';
import { AuthInfrastructureModule } from '../auth/auth-infrastructure.module';
import { AppConfig, loadConfig } from '../config/app-config';
import { ConfigModule } from '../config/config.module';
import { LogEmailSender } from './log-email-sender';
import { SmtpEmailSender } from './smtp-email-sender';

const BASE_ENV = {
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
  AUTH_SECRET: 'x'.repeat(32),
  LOG_LEVEL: 'silent',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
};

// LoggerModule is global in AppModule (docs/06 §6.5); mirror that here so LogEmailSender resolves.
async function resolvePorts(env: Record<string, string>) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
      ConfigModule,
      AuthInfrastructureModule,
    ],
  })
    .overrideProvider(AppConfig)
    .useValue(loadConfig({ ...BASE_ENV, ...env }))
    .compile();
  return moduleRef;
}

describe('EmailSender selection (docs/12 §12.4)', () => {
  it('uses the log fallback when SMTP_HOST is empty', async () => {
    const moduleRef = await resolvePorts({ SMTP_HOST: '' });
    expect(moduleRef.get(EmailSender)).toBeInstanceOf(LogEmailSender);
    await moduleRef.close();
  });

  it('uses SMTP when a host is configured', async () => {
    const moduleRef = await resolvePorts({ SMTP_HOST: 'smtp.example.com' });
    expect(moduleRef.get(EmailSender)).toBeInstanceOf(SmtpEmailSender);
    await moduleRef.close();
  });
});

describe('AuthInfrastructureModule wiring', () => {
  it('binds every auth port to a working implementation', async () => {
    const moduleRef = await resolvePorts({ SMTP_HOST: '' });

    const clock = moduleRef.get(Clock);
    const hasher = moduleRef.get(PasswordHasher);
    const tokens = moduleRef.get(SessionTokens);
    const captcha = moduleRef.get(CaptchaVerifier);

    expect(clock.now()).toBeInstanceOf(Date);
    expect(await hasher.hash('a-decent-passphrase')).toContain('$argon2id$');
    expect(tokens.generate().hash).toHaveLength(64);
    // Keys unset in this environment → no-op verifier.
    expect(captcha.isConfigured).toBe(false);

    await moduleRef.close();
  });
});
