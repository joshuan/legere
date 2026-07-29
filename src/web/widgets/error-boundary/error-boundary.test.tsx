import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import { ErrorBoundary } from './error-boundary';

function Boom(): never {
  throw new Error('widget exploded');
}

function renderWithIntl(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders its children while nothing throws', () => {
    renderWithIntl(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('All good')).toBeInTheDocument();
  });

  it('catches a failing child and offers a retry instead of taking the page down', () => {
    // React logs the caught error; silence it so the run stays readable.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    renderWithIntl(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText(messages.errors.title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: messages.common.actions.retry })).toBeInTheDocument();
  });

  it('renders a caller-supplied fallback when given one', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    renderWithIntl(
      <ErrorBoundary fallback={<p>Panel unavailable</p>}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Panel unavailable')).toBeInTheDocument();
  });
});
