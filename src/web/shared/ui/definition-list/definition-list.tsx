import { Tag } from 'antd';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

export type Definition = {
  label: ReactNode;
  value: ReactNode;
  // The values worth reading first — a title, a page count — carry the weight; the rest stay plain.
  emphasis?: boolean;
  // A value some step of the pipeline is still going to write. Shown next to the value so an empty
  // field, or one that is about to change under the reader, says so itself (docs/11 §11.5).
  pending?: 'PENDING' | 'RUNNING' | undefined;
  // What the pipeline read, when a person has since changed it. A correction is worth keeping the
  // original for: it says the machine was wrong here, and how (docs/03 §3.3.10).
  note?: ReactNode;
};

// Label, leader, value (docs/11 §11.15). A dotted leader beats a two-column table here: the pairs
// stay legible at any width, nothing has to agree on a column, and the eye is carried across a long
// gap instead of having to jump it.
export function DefinitionList({ items }: { items: Definition[] }) {
  const t = useTranslations();
  return (
    <dl className="legere-definitions">
      {items.map((item, index) => (
        <div
          className="legere-definition"
          key={typeof item.label === 'string' ? item.label : index}
        >
          <dt className="legere-definition-label">{item.label}</dt>
          <span className="legere-definition-leader" aria-hidden />
          <dd className={`legere-definition-value${item.emphasis === true ? ' is-emphasis' : ''}`}>
            {item.pending !== undefined && (
              // The same words the processing panel uses, deliberately: one vocabulary for one
              // fact, so nobody has to learn that "waiting" here means something else there
              // (docs/11 §11.5).
              <Tag
                className="legere-definition-pending"
                color={item.pending === 'RUNNING' ? 'processing' : 'default'}
              >
                {t(`viewer.stepStatus.${item.pending}`)}
              </Tag>
            )}
            {isEmpty(item.value) ? (item.pending === undefined ? '—' : null) : item.value}
            {!isEmpty(item.note) && <span className="legere-definition-note">{item.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// An em dash says "nothing here" out loud; an empty cell just looks like a rendering bug. A field
// that is still being worked on is neither — its badge is the answer.
function isEmpty(value: ReactNode): boolean {
  return value === null || value === undefined || value === '';
}
