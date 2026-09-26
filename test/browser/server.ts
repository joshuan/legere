import 'reflect-metadata';
import { mkdir } from 'node:fs/promises';
import next from 'next';
import { Clock } from '../../src/server/application/ports/clock';
import { createTestApp } from '../helpers/app';
import { disconnectTestPrisma } from '../helpers/db';
import { validateTestDatabaseUrls } from '../helpers/database-url';
import { seedBrowserData } from './seed';
import { VISUAL_NOW } from './constants';

class BrowserClock extends Clock {
  now(): Date {
    return new Date(VISUAL_NOW);
  }
}

async function main(): Promise<void> {
  validateTestDatabaseUrls();
  await mkdir(process.env.LIBRARY_ROOT ?? '/tmp/legere-browser-library', { recursive: true });
  const nextApp = next({ dev: false, dir: process.cwd() });
  await nextApp.prepare();
  const handle = nextApp.getRequestHandler();
  const keys = await seedBrowserData();
  const app = await createTestApp({
    port: Number(process.env.PORT ?? 3012),
    clock: new BrowserClock(),
    nextHandle: (req, res) => {
      void handle(req, res).catch((error: unknown) => {
        process.stderr.write(`${String(error)}\n`);
        if (!res.headersSent) res.status(500).end();
      });
    },
  });
  // The API must see actual stored artifacts before it offers preview URLs. The browser serves
  // deterministic fixture bytes at those signed URLs; the production storage implementation stays
  // untouched. No workers run here, and no external parser, model or SMTP server is called.
  for (const key of keys) await app.files.put(key, Buffer.from('browser fixture'), 'image/jpeg');
  process.stdout.write(`Browser fixture server ready at ${app.baseUrl}\n`);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await app.close();
    await nextApp.close();
    await disconnectTestPrisma();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void close().then(() => process.exit(0));
    });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
