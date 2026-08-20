import { render, screen, within, type RenderResult } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import messages from '../../../../../messages/en.json';
import { DefinitionList } from './definition-list';

// The list speaks the reader's language for its pending badges (docs/11 §11.5), so it renders
// inside the same intl provider the app gives it.
function renderList(ui: ReactElement): RenderResult {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

// Label · · · value (docs/11 §11.15).
describe('DefinitionList', () => {
  it('pairs every label with its value', () => {
    renderList(
      <DefinitionList
        items={[
          { label: 'Size', value: '1.8 GB' },
          { label: 'Pages', value: 12 },
        ]}
      />,
    );

    // A definition list, not a table: assistive tech reads the pairs as pairs.
    expect(screen.getByText('Size').tagName).toBe('DT');
    expect(screen.getByText('1.8 GB').tagName).toBe('DD');
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('says nothing out loud with an em dash rather than leaving a blank', () => {
    renderList(<DefinitionList items={[{ label: 'Pages', value: null }]} />);

    // A blank cell reads as a rendering bug; an em dash reads as "there is none".
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it("speaks the reader's language on a pending badge, the processing panel's own words", () => {
    renderList(<DefinitionList items={[{ label: 'Place', value: null, pending: 'RUNNING' }]} />);

    // One vocabulary for one fact (docs/11 §11.5): never the raw enum.
    expect(screen.getByText(messages.viewer.stepStatus.RUNNING)).toBeInTheDocument();
    expect(screen.queryByText('RUNNING')).not.toBeInTheDocument();
  });

  it('weights the values worth reading first', () => {
    renderList(
      <DefinitionList
        items={[
          { label: 'Size', value: '2 KB', emphasis: true },
          { label: 'Type', value: 'application/pdf' },
        ]}
      />,
    );

    expect(screen.getByText('2 KB').className).toContain('is-emphasis');
    expect(screen.getByText('application/pdf').className).not.toContain('is-emphasis');
  });

  it('hides the leader from the accessibility tree, since it is decoration', () => {
    const { container } = renderList(<DefinitionList items={[{ label: 'Size', value: '2 KB' }]} />);

    const row = container.querySelector('.legere-definition');
    if (!(row instanceof HTMLElement)) throw new Error('expected a row');
    expect(within(row).getByText('Size')).toBeInTheDocument();
    expect(row.querySelector('.legere-definition-leader')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });
});
