import type { ServiceName } from '../../../shared/contracts/queue';
import type { AppConfig } from './app-config';

// Where each gated service of docs/05 §5.4b lives, and what it authenticates with — resolved in one
// place because two different callers need the same answer and a second copy of it would be a
// second answer. The clients call these addresses; the probe of §5.4c publishes them and asks
// whether anything is there. An address on the panel that is not the address being called is worse
// than no address at all.
export type ServiceEndpoint = {
  // Trailing slashes stripped, exactly as the clients strip them. Empty means nothing is
  // configured — which for four of the five is a supported way to run (docs/12 §12.4).
  readonly baseUrl: string;
  // 🔒 Read here, published nowhere: the probe sends it as a bearer token and the panel never sees
  // it. Empty where the service takes none.
  readonly apiKey: string;
};

export function serviceEndpoint(config: AppConfig, service: ServiceName): ServiceEndpoint {
  if (service === 'stirling') {
    return { baseUrl: trimmed(config.get('STIRLING_URL')), apiKey: '' };
  }
  if (service === 'docling') {
    return { baseUrl: trimmed(config.get('DOCLING_URL')), apiKey: '' };
  }
  if (service === 'transcriber') {
    return {
      baseUrl: trimmed(config.get('TRANSCRIBER_API_BASE_URL')),
      apiKey: config.get('TRANSCRIBER_API_KEY'),
    };
  }
  if (service === 'embeddings') {
    return {
      baseUrl: trimmed(config.get('EMBEDDINGS_API_BASE_URL')),
      apiKey: config.get('EMBEDDINGS_API_KEY'),
    };
  }
  // An empty CLASSIFIER_API_BASE_URL reuses the embeddings endpoint, since one local runtime usually
  // serves both (docs/12 §12.4) — and the key follows the URL, because a token belongs to the host
  // it was issued for. This fallback is why this function exists: the panel has to say the address
  // the analyst actually calls, not the variable an operator left empty.
  const classifier = config.get('CLASSIFIER_API_BASE_URL');
  const key = config.get('CLASSIFIER_API_KEY');
  return {
    baseUrl: trimmed(classifier === '' ? config.get('EMBEDDINGS_API_BASE_URL') : classifier),
    apiKey: key === '' ? config.get('EMBEDDINGS_API_KEY') : key,
  };
}

function trimmed(value: string): string {
  return value.replace(/\/+$/, '');
}
