import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

// Minimal jsdom component test (docs/14 §14.8): proves the Vitest `web` project renders React.
function Hello({ name }: { name: string }): React.JSX.Element {
  return <span>Hello, {name}</span>;
}

describe('jsdom component rendering (Vitest web project)', () => {
  it('renders a React component into the document', () => {
    render(<Hello name="Legere" />);
    expect(screen.getByText('Hello, Legere')).toBeInTheDocument();
  });
});
