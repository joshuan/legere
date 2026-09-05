import { DOCUMENT_STEPS } from '../../../shared/contracts/documents';
import {
  PROCESSING_QUEUE_NAMES,
  type ProcessingTopologyDto,
} from '../../../shared/contracts/processing';
import { SERVICE_NAMES } from '../../../shared/contracts/queue';

// One declaration of how work moves through the instance. This describes relationships only: a
// queue remains a pg-boss worker, a step remains document state, and a service remains a gate around
// an external call. Consumers must never infer a one-step/one-service mapping from this graph.
export const PROCESSING_TOPOLOGY = {
  version: 1,
  queues: [
    {
      name: 'library-scan',
      kind: 'INGRESS',
      produces: ['file-ingest'],
      concurrencyConfigurable: true,
      policy: 'stately',
      expireInSeconds: 15 * 60,
    },
    {
      name: 'file-ingest',
      kind: 'INGRESS',
      produces: ['document-process'],
      concurrencyConfigurable: true,
      policy: 'standard',
      expireInSeconds: 10 * 60,
    },
    {
      name: 'document-process',
      kind: 'PIPELINE',
      produces: [],
      concurrencyConfigurable: true,
      policy: 'short',
      // Above the sum of the per-step budgets: expiry recovers a dead worker, it is not a timeout.
      expireInSeconds: 3 * 60 * 60,
    },
    {
      name: 'maintenance',
      kind: 'HOUSEKEEPING',
      produces: ['document-process'],
      concurrencyConfigurable: true,
      policy: 'standard',
      expireInSeconds: 15 * 60,
    },
  ],
  pipeline: {
    queue: 'document-process',
    steps: [
      {
        step: 'canonical',
        dependencies: [],
        resources: [{ service: 'stirling', role: 'PRIMARY', when: 'ALWAYS' }],
      },
      {
        step: 'preview',
        dependencies: [{ step: 'canonical', kind: 'ARTIFACT', holdWhen: 'UPSTREAM_UNSETTLED' }],
        resources: [{ service: 'stirling', role: 'PRIMARY', when: 'ALWAYS' }],
      },
      {
        step: 'markdown',
        dependencies: [{ step: 'canonical', kind: 'ARTIFACT', holdWhen: 'UPSTREAM_UNSETTLED' }],
        resources: [
          { service: 'docling', role: 'PRIMARY', when: 'WHEN_CONFIGURED' },
          {
            service: 'stirling',
            role: 'FALLBACK',
            when: 'WHEN_PRIMARY_UNCONFIGURED',
          },
          { service: 'stirling', role: 'AUXILIARY', when: 'WHEN_OCR_USED' },
          { service: 'transcriber', role: 'OPTIONAL', when: 'WHEN_OCR_USED' },
        ],
      },
      {
        step: 'analysis',
        dependencies: [{ step: 'markdown', kind: 'ARTIFACT', holdWhen: 'UPSTREAM_UNSETTLED' }],
        resources: [
          { service: 'classifier', role: 'PRIMARY', when: 'WHEN_CONFIGURED' },
          {
            service: 'stirling',
            role: 'AUXILIARY',
            when: 'WHEN_PAGE_IMAGES_USED',
          },
        ],
      },
      {
        step: 'fields',
        dependencies: [
          { step: 'markdown', kind: 'ARTIFACT', holdWhen: 'UPSTREAM_UNSETTLED' },
          {
            step: 'analysis',
            kind: 'CONDITIONAL_TYPE',
            holdWhen: 'UPSTREAM_UNSETTLED_AND_TYPE_MISSING',
          },
        ],
        resources: [
          { service: 'classifier', role: 'PRIMARY', when: 'WHEN_CONFIGURED' },
          {
            service: 'stirling',
            role: 'AUXILIARY',
            when: 'WHEN_PAGE_IMAGES_USED',
          },
        ],
      },
      {
        step: 'vectorization',
        dependencies: [{ step: 'markdown', kind: 'ARTIFACT', holdWhen: 'UPSTREAM_UNSETTLED' }],
        resources: [{ service: 'embeddings', role: 'PRIMARY', when: 'WHEN_CONFIGURED' }],
      },
    ],
  },
  services: [
    {
      service: 'stirling',
      steps: ['canonical', 'preview', 'markdown', 'analysis', 'fields'],
      otherConsumers: [],
    },
    { service: 'docling', steps: ['markdown'], otherConsumers: [] },
    { service: 'classifier', steps: ['analysis', 'fields'], otherConsumers: ['catalogues'] },
    { service: 'transcriber', steps: ['markdown'], otherConsumers: [] },
    { service: 'embeddings', steps: ['vectorization'], otherConsumers: ['semantic-search'] },
  ],
} as const satisfies ProcessingTopologyDto;

// These exports make completeness tests and application derivations read from the declaration,
// rather than growing another switch beside it.
export const TOPOLOGY_QUEUE_NAMES = PROCESSING_TOPOLOGY.queues.map(({ name }) => name);
export const TOPOLOGY_STEPS = PROCESSING_TOPOLOGY.pipeline.steps.map(({ step }) => step);
export const TOPOLOGY_SERVICE_NAMES = PROCESSING_TOPOLOGY.services.map(({ service }) => service);

// Compile-time witnesses as well as runtime tests: a newly added identifier makes the declaration
// fail near the graph, not later in the UI.
const _allQueues: readonly (typeof PROCESSING_QUEUE_NAMES)[number][] = TOPOLOGY_QUEUE_NAMES;
const _allSteps: readonly (typeof DOCUMENT_STEPS)[number][] = TOPOLOGY_STEPS;
const _allServices: readonly (typeof SERVICE_NAMES)[number][] = TOPOLOGY_SERVICE_NAMES;
void [_allQueues, _allSteps, _allServices];
