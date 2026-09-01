import type { Params } from 'nestjs-pino';
import {
  buildPinoHttpOptions as sharedBuildPinoHttpOptions,
  routeShapedUrl,
  serializeRequest,
  serializeResponse,
} from '@joshuan/observability/pino';
import { AppConfig } from '../config/app-config';

export { routeShapedUrl, serializeRequest, serializeResponse };

export function buildPinoHttpOptions(config: AppConfig) {
  return sharedBuildPinoHttpOptions({
    level: config.get('LOG_LEVEL'),
    development: config.get('NODE_ENV') === 'development',
  });
}

export function buildLoggerOptions(config: AppConfig): Params {
  return { pinoHttp: buildPinoHttpOptions(config) };
}
