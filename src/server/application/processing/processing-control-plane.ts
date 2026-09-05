import { DOCUMENT_STEPS, type DocumentStep } from '../../../shared/contracts/documents';
import {
  PROCESSING_QUEUE_NAMES,
  type ProcessingApplyStateDto,
  type ProcessingBlockerDto,
  type ProcessingCommandResult,
  type ProcessingControlsDto,
  type ProcessingQueueName,
  type ProcessingSettingsCommand,
  type ProcessingSnapshotResponse,
  processingTopologySchema,
} from '../../../shared/contracts/processing';
import {
  SERVICE_NAMES,
  type ListQueueFailuresQuery,
  type ListQueueFailuresResponse,
  type ReprocessByStepRequest,
  type ReprocessByStepResponse,
  type RetryJobResponse,
  type ServicesHealthResponse,
  type UpdateQueueSettingsRequest,
} from '../../../shared/contracts/queue';
import { ConflictError, ProcessingApplyError } from '../../domain/errors/domain-error';
import { CheckExternalServices } from '../health/check-external-services';
import type { Clock } from '../ports/clock';
import type { QueueName } from '../ports/job-queue';
import type { ProcessingWorkerRuntime } from '../ports/processing-worker-runtime';
import {
  GetQueueOverview,
  type ListQueueFailures,
  type RetryFailedJob,
} from '../queue/inspect-queue';
import type {
  QueueSettings,
  QueueSettingsChange,
  QueueSettingsState,
} from '../queue/queue-settings';
import type { ResumeReleasedPipelineWork } from '../queue/resume-released-pipeline-work';
import type { ReprocessDocumentsByStep } from '../queue/reprocess-by-step';
import { ServiceGates } from '../queue/service-gate';
import { PROCESSING_TOPOLOGY } from './processing-topology';

type ResumeResult = ProcessingCommandResult['resumed'][number];

// The one application-facing control surface. It composes existing mechanisms; none of those
// mechanisms is made to masquerade as another one.
export class ProcessingControlPlane {
  private mutationTail: Promise<void> = Promise.resolve();
  private lastApply: ProcessingApplyStateDto | null = null;

  constructor(
    private readonly settings: QueueSettings,
    private readonly workers: ProcessingWorkerRuntime,
    private readonly gates: ServiceGates,
    private readonly overview: GetQueueOverview,
    private readonly services: CheckExternalServices,
    private readonly releasedWork: Pick<ResumeReleasedPipelineWork, 'execute'>,
    private readonly failures: Pick<ListQueueFailures, 'execute'>,
    private readonly retryJob: Pick<RetryFailedJob, 'execute'>,
    private readonly reprocessByStep: Pick<ReprocessDocumentsByStep, 'execute'>,
    private readonly clock: Clock,
  ) {}

  async snapshot(): Promise<ProcessingSnapshotResponse> {
    const [state, overview] = await Promise.all([
      this.settings.readState(),
      this.overview.execute(),
    ]);
    const controls = state.controls;
    const workerByQueue = new Map(this.workers.snapshot().map((worker) => [worker.queue, worker]));
    const depthByQueue = new Map(overview.queues.map((queue) => [queue.name, queue]));
    const counterByStep = new Map(overview.documents.steps.map((step) => [step.step, step.counts]));
    const gateByService = new Map(overview.gates.map((gate) => [gate.service, gate]));
    const health = this.services.peek();
    const healthByService = new Map(
      (health.data?.services ?? []).map((service) => [service.service, service]),
    );
    const pipelinePaused = state.effective.paused.includes('document-process');

    return {
      generatedAt: this.clock.now().toISOString(),
      revision: state.revision,
      apply: this.applyState(state.revision),
      topology: cloneTopology(),
      queues: PROCESSING_QUEUE_NAMES.map((name) => {
        const control = queueControl(controls, name);
        const worker = workerByQueue.get(name);
        const depth = depthByQueue.get(name);
        return {
          name,
          control,
          runtime: {
            registered: worker?.registered ?? false,
            appliedConcurrency: worker?.appliedConcurrency ?? null,
            queued: depth?.queued ?? 0,
            active: depth?.active ?? 0,
            failedRecent: depth?.failedRecent ?? 0,
            oldestQueuedAt: depth?.oldestQueuedAt ?? null,
            lastCompletedAt: depth?.lastCompletedAt ?? null,
            completedLastHour: depth?.completedLastHour ?? 0,
          },
          blockers: control.paused.effective ? [{ kind: 'QUEUE_PAUSED', queue: name }] : [],
        };
      }),
      pipeline: {
        queue: 'document-process',
        unitConcurrency: controls.pipeline.unitConcurrency,
        totalDocuments: overview.documents.total,
        steps: DOCUMENT_STEPS.map((step) => {
          const control = stepControl(controls, step);
          return {
            step,
            control: { paused: control.paused },
            counts: counterByStep.get(step) ?? emptyCounts(),
            blockers: blockersForStep(
              step,
              state.effective.pausedSteps,
              pipelinePaused,
              this.lastApply,
            ),
          };
        }),
      },
      services: SERVICE_NAMES.map((service) => {
        const control = serviceControl(controls, service);
        const gate = gateByService.get(service) ?? {
          service,
          inFlight: 0,
          waiting: 0,
          longestWaitMs: 0,
          gated: false,
          throttledUntil: null,
        };
        const checked = healthByService.get(service);
        return {
          service,
          control: {
            concurrency: control.concurrency,
            cooldownSeconds: control.cooldownSeconds,
          },
          gate: {
            inFlight: gate.inFlight,
            waiting: gate.waiting,
            longestWaitMs: gate.longestWaitMs,
            gated: gate.gated,
            throttledUntil: gate.throttledUntil,
          },
          health: {
            freshness: checked === undefined ? 'UNKNOWN' : health.freshness,
            value:
              checked === undefined
                ? null
                : {
                    url: checked.url,
                    status: checked.status,
                    httpStatus: checked.httpStatus,
                    latencyMs: checked.latencyMs,
                    checkedAt: checked.checkedAt,
                    detail: checked.detail,
                  },
          },
        };
      }),
      vectors: overview.vectors,
      storage: overview.storage,
    };
  }

  update(command: ProcessingSettingsCommand, actorId: string): Promise<ProcessingCommandResult> {
    return this.serialized(() => this.apply(command, actorId));
  }

  // Compatibility for PATCH /admin/queue/settings. It shares the mutation lock, compensation and
  // resume path; the old route is no longer a second unsafe writer.
  replaceLegacy(
    input: UpdateQueueSettingsRequest,
    actorId: string,
  ): Promise<ProcessingCommandResult> {
    return this.serialized(async () => {
      const before = await this.settings.readState();
      let change: QueueSettingsChange;
      try {
        change = await this.settings.replace(input);
      } catch (error) {
        this.persistenceFailed(before, error);
      }
      return this.finishChange(change, actorId, true);
    });
  }

  checkServices(): Promise<ServicesHealthResponse> {
    return this.services.execute();
  }

  listFailures(query: ListQueueFailuresQuery): Promise<ListQueueFailuresResponse> {
    return this.failures.execute(query);
  }

  retry(jobId: string): Promise<RetryJobResponse> {
    return this.retryJob.execute(jobId);
  }

  reprocess(input: ReprocessByStepRequest, actorId: string): Promise<ReprocessByStepResponse> {
    return this.reprocessByStep.execute(input, actorId);
  }

  private async apply(
    command: ProcessingSettingsCommand,
    actorId: string,
  ): Promise<ProcessingCommandResult> {
    const current = await this.settings.readState();
    if (current.revision !== command.expectedRevision) {
      throw new ConflictError(
        'PROCESSING_SETTINGS_CHANGED',
        'Processing settings changed; read the current revision and try again',
      );
    }

    let change: QueueSettingsChange;
    try {
      change = await this.settings.apply(command);
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      this.persistenceFailed(current, error);
    }
    return this.finishChange(change, actorId, command.kind === 'service');
  }

  private persistenceFailed(before: QueueSettingsState, cause: unknown): never {
    // Nothing durable or live changed, so keep any existing DEGRADED evidence for this revision.
    // Clearing it here would turn a failed write into a false claim that runtime recovered.
    throw new ProcessingApplyError(`Processing settings were not saved: ${messageOf(cause)}`, {
      restored: true,
      desiredRevision: before.revision,
    });
  }

  private async finishChange(
    change: QueueSettingsChange,
    actorId: string,
    configureGates: boolean,
  ): Promise<ProcessingCommandResult> {
    if (!change.changed) {
      return {
        revision: change.after.revision,
        changed: false,
        apply: this.applyState(change.after.revision),
        controls: change.after.controls,
        resumed: [],
      };
    }

    const affectedQueues = changedQueues(change.before, change.after);
    const attemptedAt = this.clock.now().toISOString();
    try {
      if (configureGates) this.gates.configure(change.after.effective.services);
      if (affectedQueues.length > 0) {
        await this.workers.reconfigure(affectedQueues, change.after.effective);
      }
    } catch (error) {
      await this.compensate(change.before, change.after, affectedQueues, attemptedAt, error);
    }

    this.lastApply = {
      status: 'APPLIED',
      desiredRevision: change.after.revision,
      appliedRevision: change.after.revision,
      lastAttemptAt: attemptedAt,
      detail: null,
    };

    const resumed = await this.resumeAfterChange(change.before, change.after, actorId);
    if (resumed.warning !== null) {
      this.lastApply = {
        ...this.lastApply,
        status: 'APPLIED_WITH_WARNINGS',
        detail: resumed.warning,
      };
    }
    return {
      revision: change.after.revision,
      changed: true,
      apply: this.lastApply,
      controls: change.after.controls,
      resumed: resumed.items,
    };
  }

  private async compensate(
    before: QueueSettingsState,
    candidate: QueueSettingsState,
    queues: QueueName[],
    attemptedAt: string,
    cause: unknown,
  ): Promise<never> {
    let restored: QueueSettingsState | null = null;
    let restoreError: unknown = null;
    let gateError: unknown = null;
    let workerError: unknown = null;
    try {
      restored = await this.settings.restore(before);
    } catch (error) {
      restoreError = error;
    }
    try {
      this.gates.configure(before.effective.services);
    } catch (error) {
      gateError = error;
    }
    try {
      if (queues.length > 0) await this.workers.reconfigure(queues, before.effective);
    } catch (error) {
      workerError = error;
    }

    const rollbackErrors = [restoreError, gateError, workerError].filter((error) => error !== null);
    const recovered = rollbackErrors.length === 0;
    const detail = recovered
      ? `Apply failed and the previous settings were restored: ${messageOf(cause)}`
      : `Apply failed (${messageOf(cause)}); recovery also failed (${rollbackErrors.map(messageOf).join('; ')})`;
    this.lastApply = {
      status: recovered ? 'APPLIED' : 'DEGRADED',
      desiredRevision: restored?.revision ?? candidate.revision,
      appliedRevision: recovered ? (restored?.revision ?? before.revision) : null,
      lastAttemptAt: attemptedAt,
      detail: recovered ? null : detail,
    };
    throw new ProcessingApplyError(detail, {
      restored: recovered,
      desiredRevision: this.lastApply.desiredRevision,
    });
  }

  private async resumeAfterChange(
    before: QueueSettingsState,
    after: QueueSettingsState,
    actorId: string,
  ): Promise<{ items: ResumeResult[]; warning: string | null }> {
    if (!before.effective.pausedSteps.some((step) => !after.effective.pausedSteps.includes(step))) {
      return { items: [], warning: null };
    }

    try {
      const result = await this.releasedWork.execute({
        before: pausedStepSet(before.effective.pausedSteps),
        after: pausedStepSet(after.effective.pausedSteps),
        actorId,
      });
      const items: ResumeResult[] = DOCUMENT_STEPS.flatMap((step) =>
        result.byStep[step] === 0
          ? []
          : [{ step, documents: result.byStep[step], hasMore: result.hasMore }],
      );
      const warnings = [...result.warnings];
      if (result.hasMore) warnings.push('More released documents remain for the maintenance sweep');
      return { items, warning: warnings.length === 0 ? null : warnings.join('; ') };
    } catch (error) {
      return {
        items: [],
        warning: `The pause was released, but some held documents were not enqueued: ${messageOf(error)}`,
      };
    }
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(work, work);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private applyState(revision: number): ProcessingApplyStateDto {
    if (this.lastApply !== null && this.lastApply.desiredRevision === revision)
      return this.lastApply;
    return {
      status: 'APPLIED',
      desiredRevision: revision,
      appliedRevision: revision,
      lastAttemptAt: null,
      detail: null,
    };
  }
}

function changedQueues(before: QueueSettingsState, after: QueueSettingsState): QueueName[] {
  return PROCESSING_QUEUE_NAMES.filter(
    (queue) =>
      before.effective.concurrency[queue] !== after.effective.concurrency[queue] ||
      before.effective.paused.includes(queue) !== after.effective.paused.includes(queue),
  );
}

function blockersForStep(
  target: DocumentStep,
  paused: readonly string[],
  queuePaused: boolean,
  apply: ProcessingApplyStateDto | null,
): ProcessingBlockerDto[] {
  const blockers: ProcessingBlockerDto[] = [];
  if (queuePaused) blockers.push({ kind: 'QUEUE_PAUSED', queue: 'document-process' });
  if (paused.includes(target)) blockers.push({ kind: 'STEP_PAUSED', step: target });

  for (const root of DOCUMENT_STEPS) {
    if (root === target || !paused.includes(root)) continue;
    const path = dependencyPath(root, target);
    if (path === null) continue;
    const targetDefinition = PROCESSING_TOPOLOGY.pipeline.steps.find(({ step }) => step === target);
    const conditional = targetDefinition?.dependencies.find(({ step }) => path.includes(step));
    blockers.push({
      kind: 'DEPENDENCY_PAUSED',
      step: root,
      path,
      condition: conditional?.holdWhen ?? 'UPSTREAM_UNSETTLED',
    });
  }
  if (apply?.status === 'DEGRADED' && apply.detail !== null) {
    blockers.push({ kind: 'RUNTIME_DEGRADED', detail: apply.detail });
  }
  return blockers;
}

function dependencyPath(from: DocumentStep, to: DocumentStep): DocumentStep[] | null {
  if (from === to) return [from];
  for (const candidate of PROCESSING_TOPOLOGY.pipeline.steps) {
    if (!candidate.dependencies.some(({ step }) => step === from)) continue;
    const tail = dependencyPath(candidate.step, to);
    if (tail !== null) return [from, ...tail];
  }
  return null;
}

function queueControl(controls: ProcessingControlsDto, queue: ProcessingQueueName) {
  const found = controls.queues.find(({ name }) => name === queue);
  if (found === undefined) throw new Error(`Processing controls omit queue ${queue}`);
  return { paused: found.paused, concurrency: found.concurrency };
}

function stepControl(controls: ProcessingControlsDto, step: DocumentStep) {
  const found = controls.pipeline.steps.find((entry) => entry.step === step);
  if (found === undefined) throw new Error(`Processing controls omit step ${step}`);
  return found;
}

function serviceControl(controls: ProcessingControlsDto, service: (typeof SERVICE_NAMES)[number]) {
  const found = controls.services.find((entry) => entry.service === service);
  if (found === undefined) throw new Error(`Processing controls omit service ${service}`);
  return found;
}

function emptyCounts(): Record<
  'PENDING' | 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED',
  number
> {
  return { PENDING: 0, QUEUED: 0, RUNNING: 0, DONE: 0, FAILED: 0, SKIPPED: 0 };
}

function pausedStepSet(value: readonly string[]): ReadonlySet<DocumentStep> {
  return new Set(DOCUMENT_STEPS.filter((step) => value.includes(step)));
}

function cloneTopology(): ProcessingSnapshotResponse['topology'] {
  return processingTopologySchema.parse(PROCESSING_TOPOLOGY);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
