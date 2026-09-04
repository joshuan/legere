import { type INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import type { Server } from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
import request, { type Test as SupertestRequest } from 'supertest';
import { wireServer } from '../../server/main';
import { AppModule } from '../../src/server/app.module';
import {
  throttlerOptions,
  type ThrottleBudget,
} from '../../src/server/presentation/http/throttling';
import { CatalogueAnalyst } from '../../src/server/application/ports/catalogue-analyst';
import { EmailSender, type EmailMessage } from '../../src/server/application/ports/email-sender';
import { FileStorage } from '../../src/server/application/ports/file-storage';
import { AppConfig, loadConfig } from '../../src/server/infrastructure/config/app-config';
import { PgBossProvider } from '../../src/server/infrastructure/queue/pg-boss.provider';
import { InMemoryFileStorage } from '../../src/server/infrastructure/storage/in-memory-file-storage';

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

// A budget no suite can reach by accident, which is how a throttle behaves in every test that is
// not about throttling.
const UNTHROTTLED: ThrottleBudget = { ttl: 60_000, limit: 100_000 };

export type TestApp = {
  server: Express;
  // What the instance under test accepts for an upload, so a size test does not hardcode the
  // production default (docs/05 §5.1a).
  uploadMaxBytes: number;
  // Base URL of the one long-lived HTTP server this app listens on (see createTestApp).
  baseUrl: string;
  nestApp: INestApplication;
  emails: RecordingEmailSender;
  files: InMemoryFileStorage;
  close: () => Promise<void>;
};

export type TestAppOptions = {
  // Upload tests assert the behaviour at the limit, not the production number: moving 100 MiB
  // through the process (twice — client and server) exhausts the heap for no benefit.
  uploadMaxBytes?: number;
  // Per-IP throttle for /api/auth/*. Tests share one source address, so the real production budget
  // would trip in the middle of an unrelated suite; the default is effectively unlimited and the
  // throttling test asks for a small budget explicitly.
  throttle?: ThrottleBudget;
  // The same, for the open catalogue creates (SEC-56).
  catalogueThrottle?: ThrottleBudget;
  // The same, for POST /api/me/password (SEC-54)…
  passwordThrottle?: ThrottleBudget;
  // …and for GET /api/search and POST /api/mcp (SEC-74).
  searchThrottle?: ThrottleBudget;
  // The catalogue suggester's analyst (docs/05 §5.6c). Left alone, the real adapter is bound and
  // reports itself unconfigured, since no suite may reach a provider; a suite that wants to see
  // what a *configured* analyst does — above all, what happens when it cannot answer — puts its
  // own here.
  analyst?: CatalogueAnalyst;
  // What stands in for Next on everything outside `/api`. The default answers a marker, because no
  // API suite renders a page; the CSP suite puts a renderer here that reads the request the way Next
  // reads it (docs/10 §10.4).
  nextHandle?: (req: Request, res: Response) => void;
};

// Boots the real application over the shared Express instance, exactly as bootstrap does, with a
// stub in place of Next (no page rendering needed for API tests, and `nextHandle` for the one suite
// that does) and mail captured in memory.
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const emails = new RecordingEmailSender();
  // No e2e test may reach a real bucket (docs/14 §14.8): artifacts stay in memory and readable.
  const files = new InMemoryFileStorage();
  const throttle = options.throttle ?? UNTHROTTLED;
  const config = loadConfig({
    ...process.env,
    ...(options.uploadMaxBytes === undefined
      ? {}
      : { UPLOAD_MAX_BYTES: String(options.uploadMaxBytes) }),
  });
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EmailSender)
    .useValue(emails)
    .overrideProvider(FileStorage)
    .useValue(files)
    .overrideProvider(AppConfig)
    .useValue(config);
  if (options.analyst !== undefined) {
    builder.overrideProvider(CatalogueAnalyst).useValue(options.analyst);
  }
  const moduleRef = await builder
    .overrideProvider(getOptionsToken())
    // Every budget rides along effectively unlimited unless a test asks for it: the e2e suites
    // create catalogue rows, search and change passwords far faster than any person would. The
    // shape is the production one (docs/08 §8.4), so the per-caller tracker and the bounded storage
    // are the ones under test as well.
    .useValue(
      throttlerOptions({
        auth: throttle,
        catalogue: options.catalogueThrottle ?? UNTHROTTLED,
        password: options.passwordThrottle ?? UNTHROTTLED,
        search: options.searchThrottle ?? UNTHROTTLED,
      }),
    )
    .compile();

  const server = express();
  const nestApp = moduleRef.createNestApplication(new ExpressAdapter(server), {
    bodyParser: false,
    logger: false,
  });
  await wireServer(
    server,
    nestApp,
    options.nextHandle ??
      ((_req, res) => {
        res.status(200).json({ next: true });
      }),
  );

  // Start pg-boss but not the workers: /api/health then reports the queue the way it does in
  // production (docs/06 §6.10), while jobs stay queued for tests to inspect rather than being
  // consumed underneath them.
  await nestApp.get(PgBossProvider).start();

  // One HTTP server for the whole file, rather than letting supertest start and tear down an
  // ephemeral server per request: at e2e volumes that churn occasionally hands a client a socket
  // belonging to an already-closed server, which surfaces as an unparseable HTTP response.
  const http = await listen(server);
  const address = http.address();
  if (address === null || typeof address === 'string')
    throw new Error('server did not bind a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    server,
    baseUrl,
    nestApp,
    emails,
    files,
    uploadMaxBytes: config.get('UPLOAD_MAX_BYTES'),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await nestApp.close();
    },
  };
}

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// The origin the app is configured with in tests (test/setup.server.ts), i.e. the one the
// fail-closed CSRF check accepts (docs/08 §8.4).
export const APP_ORIGIN = 'http://localhost:3000';

// Invite and password-reset secrets live in the fragment so browsers never send them in an HTTP
// request target (SEC-38). Keep e2e callers on the same parsing rule as the web client: the old
// pathname split silently turned `/invite#token=...` into an invalid credential.
export function tokenFromFragmentUrl(url: string): string {
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get('token');
  if (token === null || token === '') throw new Error(`No token in ${url}`);
  return token;
}

// Every mutation carries a same-origin header, the way a browser on the app's own page would.
// Tests that exercise CSRF itself call supertest directly instead.
export function api(app: TestApp) {
  const withOrigin = (req: SupertestRequest): SupertestRequest => req.set('Origin', APP_ORIGIN);
  return {
    get: (path: string): SupertestRequest => request(app.baseUrl).get(path),
    post: (path: string, body: object = {}): SupertestRequest =>
      withOrigin(request(app.baseUrl).post(path)).send(body),
    patch: (path: string, body: object = {}): SupertestRequest =>
      withOrigin(request(app.baseUrl).patch(path)).send(body),
    delete: (path: string): SupertestRequest => withOrigin(request(app.baseUrl).delete(path)),
    // Raw bytes rather than JSON: the upload endpoint takes the file as the body itself
    // (docs/07 §7.3), so nothing may serialize it on the way out.
    postBinary: (path: string, body: Buffer): SupertestRequest =>
      withOrigin(request(app.baseUrl).post(path)).type('application/octet-stream').send(body),
  };
}
