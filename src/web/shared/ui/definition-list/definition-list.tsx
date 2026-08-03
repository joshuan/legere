import type { ReactNode } from 'react';

export type Definition = {
  label: ReactNode;
  value: ReactNode;
  // The values worth reading first — a title, a page count — carry the weight; the rest stay plain.
  emphasis?: boolean;
};

// Label, leader, value (docs/11 §11.15). A dotted leader beats a two-column table here: the pairs
// stay legible at any width, nothing has to agree on a column, and the eye is carried across a long
// gap instead of having to jump it.
export function DefinitionList({ items }: { items: Definition[] }) {
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
            {isEmpty(item.value) ? '—' : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// An em dash says "nothing here" out loud; an empty cell just looks like a rendering bug.
function isEmpty(value: ReactNode): boolean {
  return value === null || value === undefined || value === '';
}
