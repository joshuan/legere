import { type INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import express, { type Express } from 'express';
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

// Boots the real application over the shared Express instance, exactly as bootstrap does, with a
// stub in place of Next (no page rendering needed for API tests) and mail captured in memory.
export async function createTestApp(): Promise<TestApp> {
  const emails = new RecordingEmailSender();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EmailSender)
    .useValue(emails)
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
