import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { LoginForm } from './login-form';

const replace = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh }),
}));

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'admin@legere.local',
  displayName: 'admin',
  role: 'ADMIN',
  language: 'EN',
  theme: 'SYSTEM',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

async function fillAndSubmit(email = 'admin@legere.local', password = 'a-decent-passphrase') {
  await userEvent.type(screen.getByLabelText(enMessages.auth.fields.email), email);
  await userEvent.type(screen.getByLabelText(enMessages.auth.fields.password), password);
  await userEvent.click(screen.getByRole('button', { name: enMessages.auth.login.submit }));
}

describe('LoginForm', () => {
  it('signs in and navigates to the documents screen', async () => {
    let received: unknown = null;
    server.use(
      http.post('/api/auth/login', async ({ request }) => {
        received = await request.json();
        return HttpResponse.json(envelope(user));
      }),
    );

    renderWithProviders(<LoginForm />);
    await fillAndSubmit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents'));
    expect(received).toEqual({
      email: 'admin@legere.local',
      password: 'a-decent-passphrase',
    });
  });

  it('returns the user to where they came from', async () => {
    server.use(http.post('/api/auth/login', () => HttpResponse.json(envelope(user))));

    renderWithProviders(<LoginForm returnTo="/documents/abc" />);
    await fillAndSubmit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents/abc'));
  });

  it('shows the localized message for invalid credentials, never the server text', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json(errorEnvelope('INVALID_CREDENTIALS', 'Invalid credentials'), {
          status: 401,
        }),
      ),
    );

    renderWithProviders(<LoginForm />);
    await fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(enMessages.errors.codes.INVALID_CREDENTIALS);
    expect(alert).not.toHaveTextContent('Invalid credentials');
    expect(replace).not.toHaveBeenCalled();
  });

  it('explains a rate limit in the user’s own words', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json(errorEnvelope('RATE_LIMITED'), { status: 429 }),
      ),
    );

    renderWithProviders(<LoginForm />);
    await fillAndSubmit();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      enMessages.errors.codes.RATE_LIMITED,
    );
  });

  it('requires both fields before calling the API', async () => {
    renderWithProviders(<LoginForm />);
    await userEvent.click(screen.getByRole('button', { name: enMessages.auth.login.submit }));

    expect(await screen.findByText(enMessages.auth.login.emailRequired)).toBeInTheDocument();
    expect(screen.getByText(enMessages.auth.login.passwordRequired)).toBeInTheDocument();
  });

  it('keeps a slot for the Turnstile widget and a forgot-password hint', () => {
    renderWithProviders(<LoginForm />);

    expect(screen.getByTestId('captcha-slot')).toBeInTheDocument();
    expect(screen.getByText(enMessages.auth.login.forgot)).toBeInTheDocument();
  });
});
