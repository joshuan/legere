'use client';

import { Button, Empty, Space, Spin, Tooltip, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { Fragment, type ReactNode } from 'react';
import {
  type DocumentDetailDto,
  type DocumentEventDto,
} from '../../../../shared/contracts/documents';
import { type StepStatus } from '../../../../shared/contracts/enums';
import {
  useDocumentEvents,
  LIVE_REFRESH_MS,
  buildJournal,
  lineVerdicts,
  type JournalEntry,
  dayLabel,
  describeEvent,
  type RunLine,
  stepCost,
} from '../model/events';
import { ProcessingSection } from './processing-section';
import { stepGlyph } from './status-glyph';
import { UserAttribution } from '../../../shared/ui';

// What is being done to the document and what has been done to it, in that order (docs/11 §11.5):
// the pipeline's own panel above, the history below. They are one question asked twice — "is it
// finished, and did anything break", then "what happened" — and the first used to stand in the
// sidebar of every document while the second was a tab away.
export function LogPane({
  document,
  active,
  isAdmin,
}: {
  document: DocumentDetailDto;
  active: boolean;
  isAdmin: boolean;
}) {
  const t = useTranslations();
  // Fetched only when the tab is open — most visits never ask (docs/11 §11.5). While the pipeline
  // is working there is more to come, and not every entry follows a step change — somebody else
  // may be editing the same document (docs/10 §10.5).
  const events = useDocumentEvents(document.id, {
    enabled: active,
    refetchInterval: document.processing ? LIVE_REFRESH_MS : false,
  });
  const items = events.data?.pages.flatMap((page) => page.items) ?? [];

  let history: ReactNode = <Spin />;
  if (!events.isPending) {
    history =
      items.length === 0 ? (
        <Empty description={t('viewer.log.empty')} />
      ) : (
        <HistoryJournal
          items={items}
          steps={document.steps}
          hasMore={events.hasNextPage}
          more={() => void events.fetchNextPage()}
          loadingMore={events.isFetchingNextPage}
        />
      );
  }

  return (
    <Space orientation="vertical" size="large" style={{ width: '100%' }}>
      <ProcessingSection document={document} events={items} isAdmin={isAdmin} />

      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('viewer.log.history')}
        </Typography.Title>
        {history}
      </Space>
    </Space>
  );
}

// The document's journal (docs/03 §3.3.18, docs/11 §11.5): newest first, under day headings, each
// run folded into one entry with a line per step. A table gave every event a row of its own — two
// per step and a mostly-empty Who column — which buried the run that broke, the one thing this
// section is scanned for.
function HistoryJournal({
  items,
  steps,
  hasMore,
  more,
  loadingMore,
}: {
  items: DocumentEventDto[];
  steps: DocumentDetailDto['steps'];
  hasMore: boolean;
  more: () => void;
  loadingMore: boolean;
}) {
  const t = useTranslations();
  const entries = buildJournal(items);
  const verdicts = lineVerdicts(entries, steps);

  // Consecutive entries of one calendar day share a heading; each entry keeps a short time of its
  // own in the gutter, with the full ISO timestamp on hover (docs/11 §11.14).
  const days: Array<{ key: string; at: string; entries: JournalEntry[] }> = [];
  for (const entry of entries) {
    const key = new Date(entry.at).toDateString();
    const day = days[days.length - 1];
    if (day !== undefined && day.key === key) day.entries.push(entry);
    else days.push({ key, at: entry.at, entries: [entry] });
  }

  return (
    <div className="legere-journal">
      {days.map((day) => (
        <Fragment key={day.key}>
          <Typography.Text type="secondary" className="legere-journal-day">
            {dayLabel(day.at, t)}
          </Typography.Text>
          {day.entries.map((entry) => (
            <div className="legere-journal-row" key={entry.key}>
              <Tooltip title={entry.at}>
                <Typography.Text type="secondary" className="legere-journal-time">
                  {new Date(entry.at).toLocaleTimeString()}
                </Typography.Text>
              </Tooltip>
              <div className="legere-journal-body">
                {entry.kind === 'moment' && <JournalMoment event={entry.event} />}
                {entry.kind === 'line' && (
                  <div className="legere-steps">
                    <JournalLine
                      line={entry.line}
                      verdict={verdicts.get(entry.line.key) ?? 'INTERRUPTED'}
                    />
                  </div>
                )}
                {entry.kind === 'run' && (
                  <>
                    <Typography.Text>{describeEvent(entry.queued, t)}</Typography.Text>
                    {/* The run's head says who asked, once; its lines need no author of their
                        own — and a run the pipeline started on its own names nobody. */}
                    {entry.queued.actor !== null && (
                      <Typography.Text type="secondary"> — {entry.queued.actor}</Typography.Text>
                    )}
                    {entry.lines.length > 0 && (
                      <div className="legere-journal-lines legere-steps">
                        {entry.lines.map((line) => (
                          <JournalLine
                            key={line.key}
                            line={line}
                            verdict={verdicts.get(line.key) ?? 'INTERRUPTED'}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </Fragment>
      ))}
      {/* A history that silently ends at the page boundary reads as "nothing older happened",
          which is false as soon as a document has been re-run a few times (docs/11 §11.5). */}
      {hasMore && (
        <div>
          <Button size="small" onClick={more} loading={loadingMore}>
            {t('viewer.log.showMore')}
          </Button>
        </div>
      )}
    </div>
  );
}

// One sentence and, where a person wrote it, their name (docs/11 §11.5).
function JournalMoment({ event }: { event: DocumentEventDto }) {
  const t = useTranslations();
  return (
    <>
      <Typography.Text>{describeEvent(event, t)}</Typography.Text>
      {event.actor !== null && (
        <Typography.Text type="secondary">
          {' '}
          — <UserAttribution name={event.actor} agent={event.actorAgent} />
        </Typography.Text>
      )}
    </>
  );
}

// One step of one run: glyph, name, leader, then the verdict and what the step cost — the panel's
// own grammar (docs/11 §11.5). The message travels under its line, because the log is where
// somebody goes when something went wrong; the monospace ids under that, with a copy control —
// values to be copied into a grep, not read (docs/11 §11.14). The host among them is only ever
// sent to an admin (docs/03 §3.3.18).
function JournalLine({ line, verdict }: { line: RunLine; verdict: StepStatus | 'INTERRUPTED' }) {
  const t = useTranslations();
  const finished = line.finished;
  const source = finished ?? line.started;
  const cost = finished === null ? [] : stepCost(finished, t);
  const reason = finished?.payload.reason;
  const error = finished?.payload.error;
  return (
    <div className="legere-step">
      <div className="legere-step-line">
        <span className="legere-step-glyph" aria-hidden>
          {stepGlyph(verdict)}
        </span>
        <Typography.Text>{t(`viewer.steps.${line.step}`)}</Typography.Text>
        <span className="legere-step-leader" aria-hidden />
        <Typography.Text type="secondary" className="legere-step-state">
          {[t(`viewer.stepStatus.${verdict}`), ...cost].join(' · ')}
        </Typography.Text>
      </div>
      {reason !== undefined && (
        <Typography.Text type="secondary" className="legere-step-note">
          {t(`viewer.skipReasons.${reason}`)}
        </Typography.Text>
      )}
      {error !== undefined && (
        <Typography.Text type="danger" className="legere-step-note">
          {error}
        </Typography.Text>
      )}
      {source !== null && source.payload.service !== undefined && (
        <div className="legere-step-note">
          <Typography.Text
            type="secondary"
            code
            copyable={{ text: source.payload.requestId ?? source.payload.service }}
          >
            {[source.payload.service, source.payload.endpoint, source.payload.requestId]
              .filter((part) => part !== undefined && part !== '')
              .join(' · ')}
          </Typography.Text>
        </div>
      )}
    </div>
  );
}
