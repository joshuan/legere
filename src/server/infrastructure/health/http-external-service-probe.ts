import { Injectable } from '@nestjs/common';
import type { ServiceHealthStatus, ServiceName } from '../../../shared/contracts/queue';
import { ExternalServiceProbe, type ServiceProbeResult } from '../../application/health/ports';
import { AppConfig } from '../config/app-config';
import { serviceEndpoint } from '../config/service-endpoints';
import { callHeaders } from '../logging/async-call-context';

// The cheapest question each service answers (docs/05 §5.4c). Stirling and Docling publish one of
// their own; the three OpenAI-compatible providers do not, so they are asked to list their models —
// the one GET the shape defines, which costs no tokens and, on a provider that meters, no money.
const PROBE_PATHS: Record<ServiceName, string> = {
  stirling: '/api/v1/info/status',
  docling: '/health',
  classifier: '/models',
  transcriber: '/models',
  embeddings: '/models',
};

// 🔒 Short, and shorter than anything the pipeline allows itself. This one runs while somebody is
// looking at a page: a container that has stopped answering must make the panel slow once, not hang
// it, and "it did not answer within five seconds" is the same news to an operator as "it is down".
const TIMEOUT_MS = 5_000;

const MAX_DETAIL_CHARS = 300;

// Asks each external service whether it is there, over HTTP (docs/05 §5.4c). 🔒 It goes through no
// gate: gates exist to protect a service from the pipeline, and a question asked precisely because
// everything is stuck must not queue behind the thing that is stuck.
@Injectable()
export class HttpExternalServiceProbe extends ExternalServiceProbe {
  constructor(private readonly config: AppConfig) {
    super();
  }

  async check(service: ServiceName): Promise<ServiceProbeResult> {
    const { baseUrl, apiKey } = serviceEndpoint(this.config, service);
    if (baseUrl === '') {
      // Nothing to ask, and nothing wrong: four of the five are optional (docs/12 §12.4).
      return { url: '', status: 'NOT_CONFIGURED', httpStatus: null, latencyMs: null, detail: null };
    }

    const url = published(baseUrl);
    const startedAt = Date.now();
    try {
      const response = await fetch(`${baseUrl}${PROBE_PATHS[service]}`, {
        method: 'GET',
        headers: {
          // 🔒 Sent, never published: without it a provider that requires a key answers 401 and the
          // panel would report every correctly configured instance as refused.
          ...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
          ...callHeaders(),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const latencyMs = Date.now() - startedAt;
      // The status line is the whole answer; the body is of no interest and may be a model catalogue
      // megabytes long. Cancelled rather than left unread, so the connection is released now instead
      // of when the garbage collector gets to it.
      await response.body?.cancel().catch(() => undefined);
      return {
        url,
        status: statusOf(response.status),
        httpStatus: response.status,
        latencyMs,
        detail: null,
      };
    } catch (error) {
      // Refused, unresolved, or past the timeout — the three ways nothing comes back. The transport's
      // own words go to the tooltip, where "getaddrinfo ENOTFOUND docling" is the whole diagnosis.
      return {
        url,
        status: 'DOWN',
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
        detail: truncate(error instanceof Error ? error.message : String(error)),
      };
    }
  }
}

// What a code means for the repair somebody is about to make (docs/05 §5.4c). A refusal is named
// apart from every other failure because it is the one that is about a key rather than a host.
function statusOf(code: number): ServiceHealthStatus {
  if (code >= 200 && code < 300) return 'UP';
  if (code === 401 || code === 403) return 'UNAUTHORIZED';
  return 'ANSWERED';
}

// 🔒 A base URL may carry credentials — `https://user:pass@host` is a supported way to write one, and
// this string is about to be shown on a screen and copied into a bug report. Whatever stands in
// front of the `@` that ends the authority is one, in every form a base URL can be written in — with
// a scheme or without, parseable by `URL` or not, which is why this is done on the text rather than
// by parsing: `new URL('operator:hunter2@docling')` reports no username and keeps the password.
// Everything else is left exactly as configured, so the address on the screen is recognisable as the
// one in the environment.
function published(baseUrl: string): string {
  return baseUrl.replace(/^([^/]*\/\/)?[^/@]*@/, '$1');
}

function truncate(text: string): string {
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS)}…`;
}
