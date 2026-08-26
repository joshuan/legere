import '@testing-library/jest-dom/vitest';
import { act, screen, waitFor } from '@testing-library/react';
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
  vi.unstubAllEnvs();
  delete window.turnstile;
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

  it('will not hand a freshly signed-in user to somebody else’s page', async () => {
    server.use(http.post('/api/auth/login', () => HttpResponse.json(envelope(user))));

    renderWithProviders(<LoginForm returnTo="https://legere-intern4l.example/login" />);
    await fillAndSubmit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents'));
    expect(replace).not.toHaveBeenCalledWith('https://legere-intern4l.example/login');
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

  it('offers a forgot-password hint', () => {
    renderWithProviders(<LoginForm />);

    expect(screen.getByText(enMessages.auth.login.forgot)).toBeInTheDocument();
  });

  // 🔒 SEC-77 (docs/08 §8.4, docs/11 §11.2). The widget used to be an empty div: with the secret
  // key set, the server demanded a token nobody minted and the instance locked everybody out.
  describe('the Turnstile widget', () => {
    it('renders nothing at all on a build with no site key, and signs in as before', async () => {
      let received: unknown = null;
      server.use(
        http.post('/api/auth/login', async ({ request }) => {
          received = await request.json();
          return HttpResponse.json(envelope(user));
        }),
      );

      renderWithProviders(<LoginForm />);

      expect(screen.queryByTestId('captcha-slot')).not.toBeInTheDocument();
      await fillAndSubmit();

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents'));
      expect(received).toEqual({
        email: 'admin@legere.local',
        password: 'a-decent-passphrase',
      });
    });

    it('sends the token the widget minted, and will not submit before there is one', async () => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
      const turnstile = fakeTurnstile();
      let received: unknown = null;
      server.use(
        http.post('/api/auth/login', async ({ request }) => {
          received = await request.json();
          return HttpResponse.json(envelope(user));
        }),
      );

      renderWithProviders(<LoginForm />);
      expect(await screen.findByTestId('captcha-slot')).toBeInTheDocument();

      // Before the challenge answers, the form has nothing the server would accept — and says so
      // rather than spending the password on a request that cannot pass.
      expect(screen.getByRole('button', { name: enMessages.auth.login.submit })).toBeDisabled();

      turnstile.solve('a-minted-token');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: enMessages.auth.login.submit })).toBeEnabled(),
      );

      await fillAndSubmit();

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents'));
      expect(received).toEqual({
        email: 'admin@legere.local',
        password: 'a-decent-passphrase',
        captchaToken: 'a-minted-token',
      });
    });

    // A Turnstile token is single-use. A wrong password spends it, and a form that kept it would
    // answer the retry with a CAPTCHA failure instead of the real one.
    it('asks the widget for a fresh token after a failed attempt', async () => {
      vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
      const turnstile = fakeTurnstile();
      server.use(
        http.post('/api/auth/login', () =>
          HttpResponse.json(errorEnvelope('INVALID_CREDENTIALS'), { status: 401 }),
        ),
      );

      renderWithProviders(<LoginForm />);
      await screen.findByTestId('captcha-slot');
      turnstile.solve('a-minted-token');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: enMessages.auth.login.submit })).toBeEnabled(),
      );

      await fillAndSubmit();

      await screen.findByRole('alert');
      expect(turnstile.resets).toBe(1);
      expect(screen.getByRole('button', { name: enMessages.auth.login.submit })).toBeDisabled();
    });
  });
});

// The Cloudflare script, as far as this component is concerned: something that draws into the
// element it is given and calls back with a token. No network, and no widget to click.
function fakeTurnstile(): { solve: (token: string) => void; resets: number } {
  const state = { solve: (_token: string) => {}, resets: 0 };
  window.turnstile = {
    render: (_element, options) => {
      state.solve = (token: string) => {
        act(() => options.callback(token));
      };
      return 'widget-1';
    },
    reset: () => {
      state.resets += 1;
    },
    remove: () => {},
  };
  return {
    solve: (token: string) => state.solve(token),
    get resets() {
      return state.resets;
    },
  };
}
