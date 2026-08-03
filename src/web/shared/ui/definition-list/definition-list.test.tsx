import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DefinitionList } from './definition-list';

// Label · · · value (docs/11 §11.15).
describe('DefinitionList', () => {
  it('pairs every label with its value', () => {
    render(
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
    render(<DefinitionList items={[{ label: 'Pages', value: null }]} />);

    // A blank cell reads as a rendering bug; an em dash reads as "there is none".
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('weights the values worth reading first', () => {
    render(
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
    const { container } = render(<DefinitionList items={[{ label: 'Size', value: '2 KB' }]} />);

    const row = container.querySelector('.legere-definition');
    if (row === null) throw new Error('expected a row');
    expect(within(row).getByText('Size')).toBeInTheDocument();
    expect(row.querySelector('.legere-definition-leader')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });
});
