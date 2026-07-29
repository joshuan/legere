import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import { AppConfig } from '../config/app-config';

// pino-http options (docs/06 §6.7). Every request gets a uuid requestId (echoed as X-Request-Id and
// attached to logs). Sensitive material is never logged: cookies, auth headers, set-cookie.
export function buildPinoHttpOptions(config: AppConfig) {
  const base = {
    level: config.get('LOG_LEVEL'),
    genReqId: (_req: IncomingMessage, res: ServerResponse): string => {
      const id = randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      remove: true,
    },
  };

  // Pretty transport in dev only; production emits JSON to stdout.
  return config.isProduction ? base : { ...base, transport: { target: 'pino-pretty' } };
}

export function buildLoggerOptions(config: AppConfig): Params {
  return { pinoHttp: buildPinoHttpOptions(config) };
}
