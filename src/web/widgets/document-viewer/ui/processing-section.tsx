'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Checkbox, Space, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { Fragment, useState } from 'react';
import {
  DOCUMENT_STEPS,
  type DocumentDetailDto,
  type DocumentEventDto,
  type DocumentStep,
} from '../../../../shared/contracts/documents';
import { type StepStatus } from '../../../../shared/contracts/enums';
import type { DocumentProcessingBlockerDto } from '../../../../shared/contracts/processing';
import { documentApi, documentKeys } from '../../../entities/document';
import { useErrorMessage } from '../../../shared/lib';
import { LIVE_REFRESH_MS, formatDuration } from '../model/events';
import { stepGlyph } from './status-glyph';

// What is being done to the document right now, at the head of the tab that also says what has been
// done to it (docs/11 §11.5): "is it finished, and did anything break" and "what happened" are one
// question asked twice, and the first used to stand in the sidebar of every document while the
// second was a tab away. Each row is drawn in the same grammar the history below draws — glyph,
// name, dotted leader, the state in the reader's own words — with the duration of the newest
// settled run beside it, read off the events the tab has already fetched.
export function ProcessingSection({
  document,
  events,
  isAdmin,
}: {
  document: DocumentDetailDto;
  events: DocumentEventDto[];
  isAdmin: boolean;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  // Choosing steps is a mode entered on purpose (docs/11 §11.5): at rest the panel is a status
  // instrument, and checkboxes standing by made it read as a form when almost every visit is a
  // glance at six states.
  const [choosing, setChoosing] = useState(false);
  const [steps, setSteps] = useState<DocumentStep[]>([]);

  // A pause is not enough to explain this row: an existing artifact or document type may let a
  // downstream step proceed. Ask the document-scoped read model which pending steps are actually
  // held, and why, rather than rebuilding the dependency graph in the browser (docs/05 §5.4f).
  const processingState = useQuery({
    queryKey: documentKeys.processingState(document.id),
    queryFn: () => documentApi.processingState(document.id),
    refetchInterval: document.processing ? LIVE_REFRESH_MS : false,
  });
  const blockersByStep = new Map(
    (processingState.data?.steps ?? []).map(({ step, blockers }) => [step, blockers]),
  );
  const blockersFor = (step: DocumentStep, status: StepStatus): DocumentProcessingBlockerDto[] =>
    status === 'PENDING' ? [...(blockersByStep.get(step) ?? [])] : [];
  const blockedSteps = new Set(
    DOCUMENT_STEPS.filter((step) => blockersFor(step, document.steps[step]).length > 0),
  );
  const runnableChosen = steps.filter((step) => !blockedSteps.has(step));

  // The newest settled duration of each step (docs/11 §11.5). The list arrives newest first, so
  // the first STEP_FINISHED seen for a step is its latest run — and one that reported no duration
  // leaves none, since a missing number is not a zero.
  const durations = new Map<string, number>();
  const settled = new Set<string>();
  for (const event of events) {
    const step = event.payload.step;
    if (event.type !== 'STEP_FINISHED' || step === undefined || settled.has(step)) continue;
    settled.add(step);
    if (event.payload.durationMs !== undefined) durations.set(step, event.payload.durationMs);
  }

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.detail(document.id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.events(document.id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.processingState(document.id) });
  };

  // Asking for this one document to be analysed however long it is. A different request from "run
  // this again" — not "again" but "the limit does not apply to this one" — offered beside the
  // reason that names the limit (docs/05 §5.5 step 4).
  const analyseInFull = useMutation({
    mutationFn: () =>
      documentApi.reprocess(document.id, { steps: ['analysis'], analyseInFull: true }),
    onSuccess: () => {
      void message.success(t('viewer.processing.queued'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const reprocess = useMutation({
    mutationFn: (chosen: DocumentStep[]) =>
      documentApi.reprocess(document.id, chosen.length === 0 ? {} : { steps: chosen }),
    onSuccess: () => {
      void message.success(t('viewer.processing.queued'), 2);
      setChoosing(false);
      setSteps([]);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      {/* A heading rather than a card: the main column draws the document on the page itself, and
          a box inside a tab would be a frame around one half of it (docs/11 §11.5). The panel's own
          controls sit at the end of its head row: Reprocess everything is what the visit is for
          nearly every time, and Choose steps… is when — and not before — the checkboxes appear. */}
      <div className="legere-section-head">
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('viewer.processing.title')}
        </Typography.Title>
        {isAdmin && !choosing && (
          <Space wrap>
            <Button size="small" type="text" onClick={() => setChoosing(true)}>
              {t('viewer.processing.chooseSteps')}
            </Button>
            <Button size="small" onClick={() => reprocess.mutate([])} loading={reprocess.isPending}>
              {t('viewer.processing.reprocessAll')}
            </Button>
          </Space>
        )}
        {isAdmin && choosing && (
          <Space wrap>
            <Button
              size="small"
              type="text"
              onClick={() => {
                setChoosing(false);
                setSteps([]);
              }}
            >
              {t('common.actions.cancel')}
            </Button>
            <Button
              size="small"
              type="primary"
              disabled={runnableChosen.length === 0}
              loading={reprocess.isPending}
              onClick={() => reprocess.mutate(runnableChosen)}
            >
              {t('viewer.processing.reprocessSelected', { count: runnableChosen.length })}
            </Button>
          </Space>
        )}
      </div>

      {/* One row per step, in the pipeline's own order. What a step has to say about itself goes
          under its own name, and the remedy stands beside the complaint it answers
          (docs/11 §11.5). */}
      <div className="legere-steps">
        {DOCUMENT_STEPS.map((step) => {
          const status = document.steps[step];
          const label = t(`viewer.steps.${step}`);
          const blockers = blockersFor(step, status);
          const isBlocked = blockers.length > 0;
          const reason = document.skipReasons[step];
          const failure = document.failedStep === step ? document.processingError : null;
          const duration =
            status === 'DONE' || status === 'FAILED' || status === 'SKIPPED'
              ? durations.get(step)
              : undefined;
          return (
            <div className="legere-step" key={step}>
              <div className="legere-step-line">
                {isAdmin && choosing && (
                  <Checkbox
                    aria-label={label}
                    checked={steps.includes(step)}
                    // 🔒 A held step is not selectable: the server refuses to run it (docs/07
                    // §7.3), and a checkbox that buys a 409 is a checkbox that lies.
                    disabled={isBlocked}
                    onChange={(event) =>
                      setSteps((chosen) =>
                        event.target.checked
                          ? [...chosen, step]
                          : chosen.filter((other) => other !== step),
                      )
                    }
                  />
                )}
                <span className="legere-step-glyph" aria-hidden>
                  {stepGlyph(isBlocked ? 'PAUSED' : status)}
                </span>
                <Typography.Text>
                  {label}
                  {blockers.map((blocker, index) => (
                    <Fragment key={processingBlockerKey(blocker, index)}>
                      {' '}
                      <Tag color="orange">{processingBlockerTag(blocker, t)}</Tag>
                    </Fragment>
                  ))}
                </Typography.Text>
                <span className="legere-step-leader" aria-hidden />
                <Typography.Text type="secondary" className="legere-step-state">
                  {t(`viewer.stepStatus.${status}`)}
                  {duration !== undefined && ` · ${formatDuration(duration, t)}`}
                </Typography.Text>
              </div>
              {/* Waiting on purpose, with the exact switch or dependency which caused it. The
                  server has already evaluated artifacts and type for this document; the viewer
                  translates that answer and never infers the cascade itself. */}
              {blockers.map((blocker, index) => (
                <Typography.Text
                  type="secondary"
                  className="legere-step-note"
                  key={processingBlockerKey(blocker, index)}
                >
                  {processingBlockerHint(blocker, t)}
                </Typography.Text>
              ))}
              {/* SKIPPED alone reads like a failure; the reason says which harmless one it was —
                  and the way past the length limit stands beside the reason that names it
                  (docs/03 §3.3.10, docs/05 §5.5 step 4). */}
              {reason !== undefined && (
                <div className="legere-step-note">
                  <Typography.Text type="secondary">
                    {t(`viewer.skipReasons.${reason}`)}
                  </Typography.Text>
                  {isAdmin && step === 'analysis' && reason === 'TOO_MANY_PAGES' && (
                    <>
                      {' '}
                      <Button
                        size="small"
                        type="link"
                        onClick={() => analyseInFull.mutate()}
                        loading={analyseInFull.isPending}
                      >
                        {t('viewer.processing.analyseInFull')}
                      </Button>
                    </>
                  )}
                </div>
              )}
              {/* The message under the step that produced it rather than pooled at the bottom
                  where it names nothing — and the retry under the message (docs/11 §11.5). */}
              {(failure !== null || (isAdmin && status === 'FAILED')) && (
                <div className="legere-step-note">
                  {failure !== null && <Typography.Text type="danger">{failure}</Typography.Text>}
                  {isAdmin && status === 'FAILED' && (
                    <>
                      {failure !== null && ' '}
                      <Button
                        size="small"
                        type="link"
                        onClick={() => reprocess.mutate([step])}
                        loading={reprocess.isPending}
                      >
                        {t('viewer.processing.retryStep')}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* A failure the server could not attribute to a step still has to be readable. */}
      {document.processingError !== null && document.failedStep === null && (
        <Typography.Text type="danger" style={{ whiteSpace: 'pre-wrap' }}>
          {document.processingError}
        </Typography.Text>
      )}
    </Space>
  );
}

function processingBlockerKey(blocker: DocumentProcessingBlockerDto, index: number): string {
  if (blocker.kind === 'QUEUE_PAUSED') return `${blocker.kind}-${blocker.queue}-${index}`;
  if (blocker.kind === 'STEP_PAUSED') return `${blocker.kind}-${blocker.step}-${index}`;
  return `${blocker.kind}-${blocker.path.join('-')}-${blocker.condition}-${index}`;
}

function processingBlockerTag(
  blocker: DocumentProcessingBlockerDto,
  t: ReturnType<typeof useTranslations>,
): string {
  if (blocker.kind === 'QUEUE_PAUSED') return t('viewer.processing.queuePausedTag');
  if (blocker.kind === 'STEP_PAUSED') return t('viewer.processing.pausedTag');
  return t('viewer.processing.dependencyPausedTag', {
    step: t(`viewer.steps.${blocker.step}`),
  });
}

function processingBlockerHint(
  blocker: DocumentProcessingBlockerDto,
  t: ReturnType<typeof useTranslations>,
): string {
  if (blocker.kind === 'QUEUE_PAUSED') {
    return t('viewer.processing.queuePausedHint', { queue: blocker.queue });
  }
  if (blocker.kind === 'STEP_PAUSED') return t('viewer.processing.pausedHint');
  return t('viewer.processing.dependencyPausedHint', {
    upstream: t(`viewer.steps.${blocker.step}`),
    path: blocker.path.map((step) => t(`viewer.steps.${step}`)).join(' → '),
    condition: t(`viewer.processing.blockerConditions.${blocker.condition}`),
  });
}
