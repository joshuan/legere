import { describe, expect, it } from 'vitest';
import { DOCUMENT_STEPS } from '../../../shared/contracts/documents';
import {
  PROCESSING_QUEUE_NAMES,
  processingTopologySchema,
} from '../../../shared/contracts/processing';
import { SERVICE_NAMES } from '../../../shared/contracts/queue';
import {
  PROCESSING_TOPOLOGY,
  TOPOLOGY_QUEUE_NAMES,
  TOPOLOGY_SERVICE_NAMES,
  TOPOLOGY_STEPS,
} from './processing-topology';
import { EXPIRE_IN_SECONDS, policyOf } from '../../infrastructure/queue/pg-boss-policy';

describe('PROCESSING_TOPOLOGY', () => {
  it('is a valid public topology and names every runtime object exactly once', () => {
    expect(processingTopologySchema.parse(PROCESSING_TOPOLOGY)).toEqual(PROCESSING_TOPOLOGY);
    expect(TOPOLOGY_QUEUE_NAMES).toEqual(PROCESSING_QUEUE_NAMES);
    expect(TOPOLOGY_STEPS).toEqual(DOCUMENT_STEPS);
    expect(TOPOLOGY_SERVICE_NAMES).toEqual(SERVICE_NAMES);
    expect(new Set(TOPOLOGY_QUEUE_NAMES).size).toBe(PROCESSING_QUEUE_NAMES.length);
    expect(new Set(TOPOLOGY_STEPS).size).toBe(DOCUMENT_STEPS.length);
    expect(new Set(TOPOLOGY_SERVICE_NAMES).size).toBe(SERVICE_NAMES.length);
  });

  it('names only earlier steps as dependencies and links both sides of every service use', () => {
    const seen = new Set<string>();
    const declaredConsumers = new Map(
      PROCESSING_TOPOLOGY.services.map(({ service, steps }) => [service, new Set(steps)]),
    );

    for (const step of PROCESSING_TOPOLOGY.pipeline.steps) {
      for (const dependency of step.dependencies) expect(seen.has(dependency.step)).toBe(true);
      for (const resource of step.resources) {
        expect(declaredConsumers.get(resource.service)?.has(step.step)).toBe(true);
      }
      seen.add(step.step);
    }
  });

  it('describes markdown as a conditional multi-service step', () => {
    const markdown = PROCESSING_TOPOLOGY.pipeline.steps.find((entry) => entry.step === 'markdown');
    expect(markdown?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service: 'docling', role: 'PRIMARY' }),
        expect.objectContaining({ service: 'stirling', role: 'FALLBACK' }),
        expect.objectContaining({ service: 'transcriber', role: 'OPTIONAL' }),
      ]),
    );
  });

  it('is the policy and expiry source used by the pg-boss adapter', () => {
    for (const queue of PROCESSING_TOPOLOGY.queues) {
      expect(policyOf(queue.name)).toBe(queue.policy);
      expect(EXPIRE_IN_SECONDS[queue.name]).toBe(queue.expireInSeconds);
    }
  });
});
