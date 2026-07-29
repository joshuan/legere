import { type INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import express, { type Express } from 'express';
import request, { type Test as SupertestRequest } from 'supertest';
import { wireServer } from '../../server/main';
import { AppModule } from '../../src/server/app.module';
import { EmailSender, type EmailMessage } from '../../src/server/application/ports/email-sender';

// Captures outbound mail so e2e tests can read the verification code the same way a user reads it
// from their inbox (docs/14 §14.8: EmailSender is mocked behind its port).
export class RecordingEmailSender extends EmailSender {
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  lastTo(email: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === email);
  }

  // Codes are six digits (docs/08 §8.1.3); the body embeds exactly one.
  lastCodeFor(email: string): string {
    const body = this.lastTo(email)?.text ?? '';
    const match = /\b(\d{6})\b/.exec(body);
    if (match?.[1] === undefined) throw new Error(`No code in the last email to ${email}`);
    return match[1];
  }

  reset(): void {
    this.sent.length = 0;
  }
}

export type TestApp = {
  server: Express;
  nestApp: INestApplication;
  emails: RecordingEmailSender;
  close: () => Promise<void>;
};

export type TestAppOptions = {
  // Per-IP throttle for /api/auth/*. Tests share one source address, so the real production budget
  // would trip in the middle of an unrelated suite; the default is effectively unlimited and the
  // throttling test asks for a small budget explicitly.
  throttle?: { ttl: number; limit: number };
};

// Boots the real application over the shared Express instance, exactly as bootstrap does, with a
// stub in place of Next (no page rendering needed for API tests) and mail captured in memory.
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const emails = new RecordingEmailSender();
  const throttle = options.throttle ?? { ttl: 60_000, limit: 100_000 };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EmailSender)
    .useValue(emails)
    .overrideProvider(getOptionsToken())
    .useValue([{ name: 'auth', ...throttle }])
    .compile();

  const server = express();
  const nestApp = moduleRef.createNestApplication(new ExpressAdapter(server), {
    bodyParser: false,
    logger: false,
  });
  await wireServer(server, nestApp, (_req, res) => {
    res.status(200).json({ next: true });
  });

  return {
    server,
    nestApp,
    emails,
    close: async () => {
      await nestApp.close();
    },
  };
}

// The origin the app is configured with in tests (test/setup.server.ts), i.e. the one the
// fail-closed CSRF check accepts (docs/08 §8.4).
export const APP_ORIGIN = 'http://localhost:3000';

// Every mutation carries a same-origin header, the way a browser on the app's own page would.
// Tests that exercise CSRF itself call supertest directly instead.
export function api(app: TestApp) {
  const withOrigin = (req: SupertestRequest): SupertestRequest => req.set('Origin', APP_ORIGIN);
  return {
    get: (path: string): SupertestRequest => request(app.server).get(path),
    post: (path: string, body: object = {}): SupertestRequest =>
      withOrigin(request(app.server).post(path)).send(body),
    patch: (path: string, body: object = {}): SupertestRequest =>
      withOrigin(request(app.server).patch(path)).send(body),
    delete: (path: string): SupertestRequest => withOrigin(request(app.server).delete(path)),
  };
}
