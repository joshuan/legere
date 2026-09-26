'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  DOCUMENT_STEPS,
  QUALITY_MARKS,
  type DocumentDetailDto,
  type DocumentEventDto,
  type DocumentEventPage,
} from '../../../../shared/contracts/documents';
import { type StepStatus } from '../../../../shared/contracts/enums';
import { documentApi, documentKeys } from '../../../entities/document';

// The viewer refreshes while the pipeline is still working on this document (docs/10 §10.5).
export const LIVE_REFRESH_MS = 5000;

// The first page of the journal is asked for without a cursor; Show more names where the last one
// ended (docs/07 §7.3).
const FIRST_EVENTS_PAGE: string | undefined = undefined;

// The journal of one document, shared by everything that reads it (docs/10 §10.4): the history of
// the Log tab, the durations of the panel above it, and What it cost on the Details pane — one
// query, one request, however many of them are open.
export function useDocumentEvents(
  id: string,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  return useInfiniteQuery({
    queryKey: documentKeys.events(id),
    queryFn: ({ pageParam }) => documentApi.events(id, pageParam),
    initialPageParam: FIRST_EVENTS_PAGE,
    getNextPageParam: (page: DocumentEventPage) => page.nextCursor ?? undefined,
    ...options,
  });
}

// "How long" in the reader's own units: milliseconds under a second, one-decimal seconds above.
export function formatDuration(ms: number, t: ReturnType<typeof useTranslations>): string {
  return ms < 1000
    ? t('viewer.log.cost.ms', { value: ms })
    : t('viewer.log.cost.seconds', { value: Math.round(ms / 100) / 10 });
}

// One line of a run: a step's started and settled events folded together (docs/11 §11.5). Either
// half may be missing — a skip writes no start, an outage severs the pair (docs/05 §5.4e), and a
// page boundary can withhold one — so the line renders from whichever halves it has.
export type RunLine = {
  key: string;
  step: string;
  started: DocumentEventDto | null;
  finished: DocumentEventDto | null;
};

type JournalRun = {
  kind: 'run';
  key: string;
  at: string;
  queued: DocumentEventDto;
  lines: RunLine[];
};

export type JournalEntry =
  | JournalRun
  | { kind: 'line'; key: string; at: string; line: RunLine }
  | { kind: 'moment'; key: string; at: string; event: DocumentEventDto };

// The flat page of events folded into journal entries (docs/11 §11.5): a QUEUED opens a run, and
// the step events after it belong to the nearest earlier run that asked for that step — not merely
// the nearest, because the queue collapses two waiting requests into one job (05 §5.3), and the
// run that actually named the step would otherwise stand empty over work it asked for.
export function buildJournal(items: DocumentEventDto[]): JournalEntry[] {
  const entries: JournalEntry[] = [];
  const runs: Array<{ run: JournalRun; steps: Set<string> | null }> = [];
  // Oldest first, so a run exists by the time its steps report; reversed again at the end.
  for (const event of [...items].reverse()) {
    if (event.type === 'QUEUED') {
      const run: JournalRun = {
        kind: 'run',
        key: event.id,
        at: event.at,
        queued: event,
        lines: [],
      };
      entries.push(run);
      runs.push({
        run,
        steps: event.payload.steps === undefined ? null : new Set(event.payload.steps),
      });
      continue;
    }
    if (event.type === 'STEP_STARTED' || event.type === 'STEP_FINISHED') {
      const step = event.payload.step ?? '';
      const claiming = [...runs].reverse().find(({ steps }) => steps === null || steps.has(step));
      if (claiming !== undefined) {
        attachToRun(claiming.run.lines, event, step);
      } else {
        // A step whose opening QUEUED lies beyond the loaded page stands on a line of its own
        // until the rest of its run is fetched (docs/11 §11.5).
        entries.push({ kind: 'line', key: event.id, at: event.at, line: lineOf(event, step) });
      }
      continue;
    }
    entries.push({ kind: 'moment', key: event.id, at: event.at, event });
  }
  return entries.reverse();
}

function lineOf(event: DocumentEventDto, step: string): RunLine {
  return event.type === 'STEP_STARTED'
    ? { key: event.id, step, started: event, finished: null }
    : { key: event.id, step, started: null, finished: event };
}

// A settled event closes the newest open line of its step — the same requestId when both halves
// carry one (docs/03 §3.3.18) — or opens a lone line of its own: a skip writes no start.
function attachToRun(lines: RunLine[], event: DocumentEventDto, step: string): void {
  if (event.type === 'STEP_STARTED') {
    lines.push(lineOf(event, step));
    return;
  }
  const open = [...lines]
    .reverse()
    .find(
      (line) =>
        line.step === step &&
        line.finished === null &&
        line.started !== null &&
        (line.started.payload.requestId === undefined ||
          event.payload.requestId === undefined ||
          line.started.payload.requestId === event.payload.requestId),
    );
  if (open === undefined) {
    lines.push(lineOf(event, step));
    return;
  }
  open.finished = event;
}

// What each line gets to say for itself. A settled line says its verdict; an open one is "running"
// only while the pipeline is actually on that step — and only the newest open line of it: every
// older one was severed by an outage, and is told so rather than left pretending (docs/05 §5.4e).
export function lineVerdicts(
  entries: JournalEntry[],
  steps: DocumentDetailDto['steps'],
): Map<string, StepStatus | 'INTERRUPTED'> {
  const lines: RunLine[] = [];
  for (const entry of entries) {
    if (entry.kind === 'run') lines.push(...entry.lines);
    if (entry.kind === 'line') lines.push(entry.line);
  }
  const newestOpen = new Map<string, RunLine>();
  for (const line of lines) {
    if (line.finished !== null || line.started === null) continue;
    const held = newestOpen.get(line.step);
    if (held?.started === undefined || held.started === null || held.started.at < line.started.at) {
      newestOpen.set(line.step, line);
    }
  }
  const verdicts = new Map<string, StepStatus | 'INTERRUPTED'>();
  for (const line of lines) {
    const status = line.finished?.payload.status;
    if (status === 'DONE' || status === 'FAILED' || status === 'SKIPPED') {
      verdicts.set(line.key, status);
      continue;
    }
    if (line.finished !== null) {
      // The writer knows three verdicts (docs/03 §3.3.18); an odd one is at least settled.
      verdicts.set(line.key, 'DONE');
      continue;
    }
    const known = DOCUMENT_STEPS.find((step) => step === line.step);
    const running = known !== undefined && steps[known] === 'RUNNING';
    verdicts.set(
      line.key,
      running && newestOpen.get(line.step) === line ? 'RUNNING' : 'INTERRUPTED',
    );
  }
  return verdicts;
}

// Today and yesterday by name, any other day by its date (docs/11 §11.5).
export function dayLabel(at: string, t: ReturnType<typeof useTranslations>): string {
  const day = new Date(at);
  const now = new Date();
  const startOf = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.round((startOf(now) - startOf(day)) / 86_400_000);
  if (daysAgo === 0) return t('viewer.log.today');
  if (daysAgo === 1) return t('viewer.log.yesterday');
  return day.toLocaleDateString(navigator.language, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// One sentence per entry, built from the payload each type happens to carry. Written here rather
// than on the server: it is the reader's language, and the server does not know it (docs/10 §10.3).
// Step events never reach it — they are folded into the lines of their run, not sentences
// (docs/11 §11.5).
export function describeEvent(
  event: DocumentEventDto,
  t: ReturnType<typeof useTranslations>,
): string {
  const { payload } = event;

  if (event.type === 'QUEUED') {
    const steps = (payload.steps ?? []).map((one) => t(`viewer.steps.${one}`)).join(', ');
    return steps === '' ? t('viewer.log.queued') : t('viewer.log.queuedSteps', { steps });
  }
  // 🔒 The path of a library file only reaches an admin (docs/03 §3.3.18), so each of these
  // sentences has a form that names no folder: the entry still says what happened.
  const path = payload.path;
  if (event.type === 'CREATED') {
    return path === undefined ? t('viewer.log.createdBare') : t('viewer.log.created', { path });
  }
  if (event.type === 'FILE_ATTACHED') {
    return path === undefined
      ? t('viewer.log.fileAttachedBare')
      : t('viewer.log.fileAttached', { path });
  }
  if (event.type === 'FILE_MISSING') {
    return path === undefined
      ? t('viewer.log.fileMissingBare')
      : t('viewer.log.fileMissing', { path });
  }
  // A record, not a live reference: the title still says which paper it was after the other side
  // is gone (docs/03 §3.3.23).
  if (event.type === 'LINKED' || event.type === 'UNLINKED') {
    const title = payload.otherTitle ?? payload.otherDocumentId ?? '';
    return event.type === 'LINKED'
      ? t('viewer.log.linked', { title })
      : t('viewer.log.unlinked', { title });
  }

  const changes = Object.entries(payload.changes ?? {})
    .map(([field, change]) =>
      t('viewer.log.change', {
        // A typed field's entry names the field by its key ("fields.vendor" → "vendor"): legible
        // without a per-schema catalogue lookup the log cannot make (docs/03 §3.3.10a).
        field: field.startsWith('fields.')
          ? field.slice('fields.'.length)
          : t(`viewer.details.${field}`),
        from:
          change.from === null || change.from === undefined || change.from === ''
            ? '—'
            : change.from,
        to: change.to === null || change.to === undefined || change.to === '' ? '—' : change.to,
      }),
    )
    .join('; ');
  return changes === '' ? t('viewer.log.metaChanged') : changes;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The numbers a step answered with, in the order somebody asks them: how long, how much came out,
// what it cost (docs/03 §3.3.18). Only the ones the step actually reported — a missing number is
// not a zero.
export function stepCost(event: DocumentEventDto, t: ReturnType<typeof useTranslations>): string[] {
  const { payload } = event;
  const parts: string[] = [];
  if (payload.durationMs !== undefined) parts.push(formatDuration(payload.durationMs, t));
  if (payload.pages !== undefined) parts.push(t('viewer.log.cost.pages', { value: payload.pages }));
  if (payload.chars !== undefined) parts.push(t('viewer.log.cost.chars', { value: payload.chars }));
  if (payload.ocrUsed === true) parts.push(t('viewer.log.cost.ocr'));
  // Two engines write the same field now, and which one wrote a bad result is the first question.
  if (payload.transcribed === true) parts.push(t('viewer.log.cost.transcribed'));
  if (payload.promptTokens !== undefined || payload.completionTokens !== undefined) {
    parts.push(
      t('viewer.log.cost.tokens', {
        prompt: payload.promptTokens ?? 0,
        completion: payload.completionTokens ?? 0,
      }),
    );
  }
  // What the step made of its own work, last of the row and out of a hundred, so a mark reads as a
  // score of the reading rather than as a fourth measurement of the document (docs/11 §11.5).
  // 🔒 Drawn and nothing more: nothing on this screen acts on one.
  for (const mark of QUALITY_MARKS) {
    const value = payload[mark];
    if (value !== undefined) parts.push(t(`viewer.log.cost.${mark}`, { value }));
  }
  return parts;
}
