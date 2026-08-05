import '@testing-library/jest-dom/vitest';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { renderWithProviders } from '../../../../test/helpers/render';
import { AdminInstanceScreen } from './admin-instance-screen';

const instance = {
  groups: [
    {
      key: 'core',
      settings: [
        {
          key: 'APP_BASE_URL',
          value: 'https://legere.example.com',
          source: 'ENV',
          consequence: null,
        },
        { key: 'LOG_LEVEL', value: 'info', source: 'DEFAULT', consequence: null },
      ],
    },
    {
      key: 'database',
      settings: [
        { key: 'DATABASE_HOST', value: 'db.internal', source: 'ENV', consequence: null },
        { key: 'DATABASE_NAME', value: 'archive', source: 'ENV', consequence: null },
      ],
    },
    {
      key: 'email',
      settings: [
        {
          key: 'SMTP_HOST',
          value: null,
          source: 'DEFAULT',
          consequence: 'EMAIL_CODES_TO_LOG',
        },
        { key: 'SMTP_PASSWORD', value: null, source: 'SET', consequence: null },
      ],
    },
    {
      key: 'auth',
      settings: [
        {
          key: 'TURNSTILE_SECRET_KEY',
          value: null,
          source: 'UNSET',
          consequence: 'CAPTCHA_DISABLED',
        },
      ],
    },
  ],
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(http.get('/api/admin/instance', () => HttpResponse.json(envelope(instance))));
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// The row a label belongs to — a definition list is label, leader, value in one container.
function rowFor(label: string): HTMLElement {
  const element = screen.getByText(label).closest('.legere-definition');
  if (element === null) throw new Error(`no row for ${label}`);
  if (!(element instanceof HTMLElement)) throw new Error(`row for ${label} is not an element`);
  return element;
}

describe('AdminInstanceScreen', () => {
  it('shows a card per group with its settings', async () => {
    renderWithProviders(<AdminInstanceScreen />);
    await screen.findByText('Base URL');

    expect(groupTitles()).toEqual(['Core', 'Database', 'Email', 'Authentication']);

    // A human name and the variable behind it, so a row can be acted on without a lookup table.
    expect(screen.getByText('APP_BASE_URL')).toBeInTheDocument();
    expect(within(rowFor('Base URL')).getByText('https://legere.example.com')).toBeInTheDocument();
    expect(within(rowFor('Host')).getByText('db.internal')).toBeInTheDocument();
  });

  it('says where each value came from', async () => {
    renderWithProviders(<AdminInstanceScreen />);
    await screen.findByText('Base URL');

    expect(within(rowFor('Base URL')).getByText('Environment')).toBeInTheDocument();
    expect(within(rowFor('Log level')).getByText('Default')).toBeInTheDocument();
  });

  it('reads a blank as "Not set", with what it costs beside it', async () => {
    renderWithProviders(<AdminInstanceScreen />);
    await screen.findByText('SMTP host');

    const smtp = within(rowFor('SMTP host'));
    expect(smtp.getByText('Not set')).toBeInTheDocument();
    // The server sends a token; the page shows the sentence, in the locale everything else is in.
    expect(smtp.queryByText('EMAIL_CODES_TO_LOG')).not.toBeInTheDocument();
    expect(
      smtp.getByText(
        'No mail server is configured: verification and invite codes are printed to the application log instead of being sent.',
      ),
    ).toBeInTheDocument();

    // A value that is there says nothing extra beside it.
    expect(within(rowFor('Base URL')).queryByText(/not set/i)).not.toBeInTheDocument();
  });

  it('🔒 shows a secret as Set or Not set, never as a value', async () => {
    renderWithProviders(<AdminInstanceScreen />);
    await screen.findByText('SMTP password');

    const password = within(rowFor('SMTP password'));
    expect(password.getByText('Set')).toBeInTheDocument();
    expect(password.getByText('Secret')).toBeInTheDocument();

    const turnstile = within(rowFor('Turnstile secret key'));
    expect(turnstile.getByText('Not set')).toBeInTheDocument();
    expect(
      turnstile.getByText(
        'CAPTCHA is disabled: login and registration accept requests without a challenge.',
      ),
    ).toBeInTheDocument();
  });

  it('reports a failure instead of an empty page', async () => {
    server.use(
      http.get('/api/admin/instance', () =>
        HttpResponse.json(errorEnvelope('FORBIDDEN'), { status: 403 }),
      ),
    );

    renderWithProviders(<AdminInstanceScreen />);

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
  });
});

// One card per group, in the order the server sent them.
function groupTitles(): string[] {
  return [...document.querySelectorAll('.ant-card-head-title')].map(
    (title) => title.textContent ?? '',
  );
}
