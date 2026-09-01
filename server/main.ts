import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { type INestApplication } from '@nestjs/common';
import { wireNextNestStack } from '@joshuan/next-nest';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Logger as PinoLogger } from 'nestjs-pino';
import next from 'next';
import { pinoHttp } from 'pino-http';
import { AppModule } from '../src/server/app.module';
import { CallContext } from '../src/server/application/ports/call-context';
import {
  AppConfig,
  configWarnings,
  loadConfig,
} from '../src/server/infrastructure/config/app-config';
import { buildPinoHttpOptions } from '../src/server/infrastructure/logging/logger.options';
import { WorkerRegistry } from '../src/server/infrastructure/queue/worker-registry';
import { isRawBodyRoute } from '../src/server/presentation/documents/read-upload-body';
import { callContextMiddleware } from '../src/server/presentation/http/call-context.middleware';
import { csrfOriginCheck } from '../src/server/presentation/http/csrf.middleware';
import { errorEnvelope } from '../src/server/presentation/http/envelope';
import { forwardedForNotice } from '../src/server/presentation/http/forwarded-for-notice.middleware';
import { readOnlyBearer } from '../src/server/presentation/http/read-only-bearer.middleware';
import { securityHeaders } from '../src/server/presentation/http/security-headers.middleware';
import { jsonRpcParseError } from '../src/server/presentation/mcp/json-rpc-parse-error.middleware';

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
  const config = nestApp.get(AppConfig);
  // 🔒 Off unless the operator says otherwise (docs/12 §12.8). Express reads `req.ip` from
  // `X-Forwarded-For` once this is set, and every per-IP limit in the app reads `req.ip` — so
  // trusting the header with nothing in front to rewrite it means a caller picks their own bucket.
  // Getting it wrong in the other direction costs over-throttling, which is the safe direction.
  const trustProxy = config.get('TRUST_PROXY');
  if (trustProxy !== '') {
    server.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  } else {
    // The other direction is not free either, and since M47.16 it is not gradual: read the notice.
    // The logger is resolved per call, not here — the first request is long after Nest is up.
    server.use(forwardedForNotice((message) => nestApp.get(PinoLogger).warn(message)));
  }
  const pageDispatcher: RequestHandler = (req, res, forward) => {
    if (isApiPath(req.path)) {
      forward();
      return;
    }
    nextHandle(req, res);
  };

  // 🔒 The upload routes take the file as the body itself (docs/07 §7.3), so no parser may touch
  // them. Which routes those are is declared once, beside the function that reads them, rather than
  // matched by a path equality here that a second route can silently miss — which is exactly what
  // happened to `POST /documents/:id/files`.
  const isUpload = (req: Request): boolean => isRawBodyRoute(req.method, req.path);
  const jsonBody: RequestHandler = (req, res, next) =>
    isUpload(req) ? next() : express.json({ limit: '1mb' })(req, res, next);
  const formBody: RequestHandler = (req, res, next) =>
    isUpload(req) ? next() : express.urlencoded({ extended: true })(req, res, next);
  const unknownRoute: RequestHandler = (_req, res) => {
    res.status(404).json(errorEnvelope('NOT_FOUND', 'Unknown API route'));
  };

  await wireNextNestStack<RequestHandler, ErrorRequestHandler>(
    nestApp,
    {
      disablePoweredBy: () => {
        server.disable('x-powered-by');
      },
      root: (middleware) => {
        server.use(middleware);
      },
      api: (prefix, middleware) => {
        server.use(prefix, middleware);
      },
      apiError: (prefix, middleware) => {
        server.use(prefix, middleware);
      },
      error: (middleware) => {
        server.use(middleware);
      },
    },
    {
      rootMiddleware: [
        securityHeaders({ usesHttps: config.usesHttps, bucketOrigin: config.bucketOrigin }),
        csrfOriginCheck(config.get('APP_BASE_URL')),
      ],
      pageDispatcher,
      apiMiddleware: [
        pinoHttp(buildPinoHttpOptions(loadConfig())),
        callContextMiddleware(nestApp.get(CallContext)),
        cookieParser(),
      ],
      bodyMiddleware: [jsonBody, formBody],
      afterBodyErrorMiddleware: [jsonRpcParseError],
      afterBodyMiddleware: [readOnlyBearer],
      unknownRoute,
    },
  );
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

  // Step 5 (docs/02 §2.2): pg-boss workers start after Nest is initialized — they resolve handlers
  // from its container — and before the port opens, so nothing is served while the queue is down.
  await startQueueWorkers(nestApp);

  const config = nestApp.get(AppConfig);
  const port = config.get('PORT');
  server.listen(port, () => {
    const logger = nestApp.get(PinoLogger);
    logger.log(`Legere listening on :${port} (dev=${dev})`);
    // What this instance is running on that is not wrong but costs something (docs/12 §12.4a).
    // Production refuses the rest at boot; these are the ones an operator should choose knowingly.
    for (const warning of configWarnings(config)) logger.warn(warning);
    // Every one of these degrades quietly when it is not set — parsing falls back to a converter
    // that flattens the document, categorization and semantic search simply do not happen. Saying
    // so once at startup is the difference between "configured off" and "forgot to configure".
    logger.log(
      `Optional integrations: ${describe([
        [
          'parsing',
          config.get('DOCLING_URL') === '' ? 'Stirling fallback (flattens layout)' : 'Docling',
        ],
        ['picture captions', config.get('DOCLING_PICTURE_DESCRIPTION') ? 'on' : 'off'],
        ['AI analysis', providerOf(config, 'CLASSIFIER_API_BASE_URL', 'CLASSIFIER_MODEL')],
        ['embeddings', providerOf(config, 'EMBEDDINGS_API_BASE_URL', 'EMBEDDINGS_MODEL')],
      ])}`,
    );
  });
}

function describe(pairs: Array<[string, string]>): string {
  return pairs.map(([name, state]) => `${name}=${state}`).join(', ');
}

// A base URL alone is not enough to call anything: without a model name there is nothing to ask.
function providerOf(
  config: AppConfig,
  urlKey: 'CLASSIFIER_API_BASE_URL' | 'EMBEDDINGS_API_BASE_URL',
  modelKey: 'CLASSIFIER_MODEL' | 'EMBEDDINGS_MODEL',
): string {
  const url =
    config.get(urlKey) === '' ? config.get('EMBEDDINGS_API_BASE_URL') : config.get(urlKey);
  const model = config.get(modelKey);
  return url === '' || model === '' ? 'not configured (steps will be SKIPPED)' : model;
}

// Starting workers is separated so tests can boot the HTTP surface without consuming jobs.
export async function startQueueWorkers(nestApp: INestApplication): Promise<void> {
  const workers = nestApp.get(WorkerRegistry);
  await workers.scheduleSystemCrons();
  await workers.start();
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
