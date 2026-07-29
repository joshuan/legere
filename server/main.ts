import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import express, { type Express, type Request, type Response } from 'express';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Logger as PinoLogger } from 'nestjs-pino';
import next from 'next';
import { pinoHttp } from 'pino-http';
import { AppModule } from '../src/server/app.module';
import { AppConfig, loadConfig } from '../src/server/infrastructure/config/app-config';
import { buildPinoHttpOptions } from '../src/server/infrastructure/logging/logger.options';
import { csrfOriginCheck } from '../src/server/presentation/http/csrf.middleware';
import { errorEnvelope } from '../src/server/presentation/http/envelope';

// A request handler for everything Nest does not serve (Next pages/assets, or a stub in tests).
type NextHandle = (req: Request, res: Response) => void;

const isApiPath = (path: string): boolean => path === '/api' || path.startsWith('/api/');

// Wire the shared Express instance (docs/02 §2.2, docs/06 §6.9). Ordering is load-bearing:
// the /api dispatcher and body parsers are registered BEFORE nestApp.init() (otherwise Nest would
// intercept Next pages with its own 404); the terminal /api JSON 404 goes AFTER init so unknown
// /api routes fall through Nest. Body parsers are scoped to /api only (global ones break Next
// server actions). Nest never calls listen — it rides the shared Express instance.
export async function wireServer(
  server: Express,
  nestApp: INestApplication,
  nextHandle: NextHandle,
): Promise<void> {
  server.set('trust proxy', 1);
  nestApp.setGlobalPrefix('api');

  server.use((req, res, forward) => {
    if (isApiPath(req.path)) {
      forward();
      return;
    }
    nextHandle(req, res);
  });
  // Request logging + requestId for every /api request (docs/06 §6.7). Mounted explicitly rather than
  // via nestjs-pino's Nest middleware, which does not run reliably behind the shared Express instance
  // + global prefix + dispatcher; nestjs-pino remains the Nest application logger.
  server.use('/api', pinoHttp(buildPinoHttpOptions(loadConfig())));
  server.use('/api', cookieParser());
  server.use('/api', express.json({ limit: '1mb' }));
  server.use('/api', express.urlencoded({ extended: true }));
  // Fail-closed CSRF origin check on every mutating /api request (docs/08 §8.4), before Nest sees it.
  server.use('/api', csrfOriginCheck(nestApp.get(AppConfig).get('APP_BASE_URL')));

  await nestApp.init();

  server.use('/api', (_req: Request, res: Response) => {
    res.status(404).json(errorEnvelope('NOT_FOUND', 'Unknown API route'));
  });
}

export async function bootstrap({ dev }: { dev: boolean }): Promise<void> {
  const server = express();

  // Prepare Next FIRST; capture its request handler once (docs/02 §2.2).
  const nextApp = next({ dev, dir: process.cwd() });
  await nextApp.prepare();
  const handle = nextApp.getRequestHandler();

  // Nest without a global body parser — parsers are mounted on /api only in wireServer.
  const nestApp = await NestFactory.create(AppModule, new ExpressAdapter(server), {
    bodyParser: false,
    bufferLogs: true,
  });
  nestApp.useLogger(nestApp.get(PinoLogger));
  nestApp.enableShutdownHooks();

  await wireServer(server, nestApp, (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.status(500).end();
    });
  });

  const port = nestApp.get(AppConfig).get('PORT');
  server.listen(port, () => {
    nestApp.get(PinoLogger).log(`Legere listening on :${port} (dev=${dev})`);
  });
}

// Auto-start in production (`node dist/server/main.js`, a CommonJS entry). In dev/tests the runner
// imports { bootstrap } and calls it; the `typeof require` guard keeps this inert under the ESM dev
// loader, where `require` is undefined.
if (typeof require !== 'undefined' && require.main === module) {
  bootstrap({ dev: false }).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
