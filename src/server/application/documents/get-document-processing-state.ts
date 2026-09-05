import type { DocumentStep } from '../../../shared/contracts/documents';
import type {
  DocumentProcessingBlockerDto,
  DocumentProcessingStateResponse,
  ProcessingDependencyDto,
} from '../../../shared/contracts/processing';
import { heldSteps } from '../../domain/entities/pipeline-pause';
import type { DocumentDetail } from '../../domain/repositories/document.repository';
import type { QueueSettings } from '../queue/queue-settings';
import { PROCESSING_TOPOLOGY } from '../processing/processing-topology';

// The non-admin view of instance pauses for one already-authorized document. QueueSettings is read
// once so every blocker in the response describes the same desired revision, even while an admin
// is changing controls in another request.
export class GetDocumentProcessingState {
  constructor(private readonly settings: Pick<QueueSettings, 'read'>) {}

  async execute(detail: DocumentDetail): Promise<DocumentProcessingStateResponse> {
    const settings = await this.settings.read();
    const pausedSteps = PROCESSING_TOPOLOGY.pipeline.steps
      .map(({ step }) => step)
      .filter((step) => settings.pausedSteps.includes(step));
    const explicitlyPaused = new Set<DocumentStep>(pausedSteps);
    const effectivelyHeld = heldSteps(explicitlyPaused, detail.document);
    const queuePaused = settings.paused.includes(PROCESSING_TOPOLOGY.pipeline.queue);

    return {
      pausedSteps,
      steps: PROCESSING_TOPOLOGY.pipeline.steps.map(({ step }) => ({
        step,
        blockers:
          detail.document.steps[step] === 'PENDING'
            ? blockersForStep(step, detail, pausedSteps, effectivelyHeld, queuePaused)
            : [],
      })),
    };
  }
}

function blockersForStep(
  target: DocumentStep,
  detail: DocumentDetail,
  explicitlyPaused: readonly DocumentStep[],
  effectivelyHeld: ReadonlySet<DocumentStep>,
  queuePaused: boolean,
): DocumentProcessingBlockerDto[] {
  const blockers: DocumentProcessingBlockerDto[] = [];
  if (queuePaused) {
    blockers.push({ kind: 'QUEUE_PAUSED', queue: PROCESSING_TOPOLOGY.pipeline.queue });
  }
  if (explicitlyPaused.includes(target)) {
    blockers.push({ kind: 'STEP_PAUSED', step: target });
  }
  if (!effectivelyHeld.has(target)) return blockers;

  for (const root of explicitlyPaused) {
    if (root === target) continue;
    // Evaluate each root independently. Otherwise a settled canonical could be blamed for a field
    // which is really held by a separate analysis pause in the same settings snapshot.
    if (!heldSteps(new Set<DocumentStep>([root]), detail.document).has(target)) continue;
    const path = shortestDependencyPath(root, target);
    if (path === null) continue;
    blockers.push({
      kind: 'DEPENDENCY_PAUSED',
      step: root,
      path,
      condition: finalCondition(path),
    });
  }
  return blockers;
}

// Breadth first is significant: fields has a direct Markdown input as well as the conditional path
// Markdown -> analysis -> fields. The direct dependency is the effective, more precise reason.
function shortestDependencyPath(from: DocumentStep, to: DocumentStep): DocumentStep[] | null {
  const paths: DocumentStep[][] = [[from]];
  const visited = new Set<DocumentStep>([from]);

  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    if (path === undefined) continue;
    const tail = path[path.length - 1];
    if (tail === undefined) continue;

    for (const candidate of PROCESSING_TOPOLOGY.pipeline.steps) {
      if (!candidate.dependencies.some(({ step }) => step === tail)) continue;
      const next = candidate.step;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      if (!visited.has(next)) {
        visited.add(next);
        paths.push(nextPath);
      }
    }
  }
  return null;
}

function finalCondition(path: readonly DocumentStep[]): ProcessingDependencyDto['holdWhen'] {
  const target = path[path.length - 1];
  const parent = path[path.length - 2];
  const definition = PROCESSING_TOPOLOGY.pipeline.steps.find(({ step }) => step === target);
  const dependency = definition?.dependencies.find(({ step }) => step === parent);
  if (dependency === undefined) throw new Error(`Topology omits dependency ${parent} -> ${target}`);
  return dependency.holdWhen;
}
