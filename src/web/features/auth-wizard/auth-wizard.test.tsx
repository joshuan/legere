import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AuthWizard } from './auth-wizard';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh: vi.fn() }) }));

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

const inTenMinutes = () => new Date(Date.now() + 600_000).toISOString();

function mockHappyPath(onStart?: (body: unknown) => void) {
  server.use(
    http.post('/api/auth/register/start', async ({ request }) => {
      onStart?.(await request.json());
      return HttpResponse.json(envelope({ expiresAt: inTenMinutes() }));
    }),
    http.post('/api/auth/register/verify', () =>
      HttpResponse.json(envelope({ ticket: 't'.repeat(32), expiresAt: inTenMinutes() })),
    ),
    http.post('/api/auth/register/complete', () => HttpResponse.json(envelope(user))),
  );
}

async function submitEmail(email = 'admin@legere.local') {
  await userEvent.type(screen.getByLabelText(enMessages.auth.fields.email), email);
  await userEvent.click(
    screen.getByRole('button', { name: enMessages.auth.wizard.actions.sendCode }),
  );
}

// antd's OTP renders one input per digit; typing into the first fills the rest.
async function typeCode(code: string) {
  const [firstDigit] = await screen.findAllByRole('textbox');
  if (firstDigit === undefined) throw new Error('code input not rendered');
  await userEvent.type(firstDigit, code);
}

describe('AuthWizard', () => {
  it('drives the three steps and lands the user in the app', async () => {
    const started: unknown[] = [];
    mockHappyPath((body) => started.push(body));

    renderWithProviders(<AuthWizard mode="onboarding" />);
    expect(screen.getByText(enMessages.auth.wizard.title.onboarding)).toBeInTheDocument();

    await submitEmail();
    // Step 2: the code was sent and the TTL is counting down.
    expect(await screen.findByText(/We sent a code to admin@legere.local/)).toBeInTheDocument();
    expect(started).toEqual([{ email: 'admin@legere.local' }]);

    await typeCode('123456');

    // Step 3: password + confirmation.
    const password = await screen.findByLabelText(enMessages.auth.fields.password);
    await userEvent.type(password, 'a-decent-passphrase');
    await userEvent.type(
      screen.getByLabelText(enMessages.auth.fields.passwordConfirm),
      'a-decent-passphrase',
    );
    await userEvent.click(
      screen.getByRole('button', { name: enMessages.auth.wizard.actions.finish }),
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents'));
  });

  it('will not hand a freshly signed-in user to somebody else’s page', async () => {
    mockHappyPath();

    renderWithProviders(<AuthWizard mode="invite" returnTo="//evil.example/login" />);
    await submitEmail();
    await typeCode('123456');

    const password = await screen.findByLabelText(enMessages.auth.fields.password);
    await userEvent.type(password, 'a-decent-passphrase');
    await userEvent.type(
      screen.getByLabelText(enMessages.auth.fields.passwordConfirm),
      'a-decent-passphrase',
    );
    await userEvent.click(
      screen.getByRole('button', { name: enMessages.auth.wizard.actions.finish }),
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents'));
    expect(replace).not.toHaveBeenCalledWith('//evil.example/login');
  });

  it('carries the invite token into register/start', async () => {
    const started: unknown[] = [];
    mockHappyPath((body) => started.push(body));

    renderWithProviders(
      <AuthWizard mode="invite" token={'i'.repeat(32)} initialEmail="new@legere.local" />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: enMessages.auth.wizard.actions.sendCode }),
    );

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toEqual({ email: 'new@legere.local', inviteToken: 'i'.repeat(32) });
  });

  it('carries the reset token and shows the masked address as a hint', async () => {
    const started: unknown[] = [];
    mockHappyPath((body) => started.push(body));

    renderWithProviders(
      <AuthWizard
        mode="reset"
        token={'r'.repeat(32)}
        emailHint="Enter the address for a***n@legere.local."
      />,
    );
    expect(screen.getByText('Enter the address for a***n@legere.local.')).toBeInTheDocument();

    await submitEmail('admin@legere.local');
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toEqual({ email: 'admin@legere.local', resetToken: 'r'.repeat(32) });
  });

  it('shows a localized error for a wrong code and stays on the code step', async () => {
    mockHappyPath();
    server.use(
      http.post('/api/auth/register/verify', () =>
        HttpResponse.json(errorEnvelope('EMAIL_CODE_INVALID'), { status: 400 }),
      ),
    );

    renderWithProviders(<AuthWizard mode="onboarding" />);
    await submitEmail();
    await typeCode('000000');

    // The "code sent" notice is also an alert, so match the message itself.
    expect(await screen.findByText(enMessages.errors.codes.EMAIL_CODE_INVALID)).toBeInTheDocument();
    // Still on step 2: the password field never appears.
    expect(screen.queryByLabelText(enMessages.auth.fields.passwordConfirm)).not.toBeInTheDocument();
  });

  it('sends the user back to the first step when the series is burned', async () => {
    mockHappyPath();
    server.use(
      http.post('/api/auth/register/verify', () =>
        HttpResponse.json(errorEnvelope('EMAIL_CODE_TOO_MANY_ATTEMPTS'), { status: 429 }),
      ),
    );

    renderWithProviders(<AuthWizard mode="onboarding" />);
    await submitEmail();
    await typeCode('000000');

    expect(
      await screen.findByText(enMessages.errors.codes.EMAIL_CODE_TOO_MANY_ATTEMPTS),
    ).toBeInTheDocument();
    // Back on the email step, ready to request a fresh code.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: enMessages.auth.wizard.actions.sendCode }),
      ).toBeInTheDocument(),
    );
  });

  it('enforces the password rules before calling the API', async () => {
    mockHappyPath();

    renderWithProviders(<AuthWizard mode="onboarding" />);
    await submitEmail();
    await typeCode('123456');

    const password = await screen.findByLabelText(enMessages.auth.fields.password);
    await userEvent.type(password, 'password');
    await userEvent.type(screen.getByLabelText(enMessages.auth.fields.passwordConfirm), 'password');
    await userEvent.click(
      screen.getByRole('button', { name: enMessages.auth.wizard.actions.finish }),
    );

    expect(await screen.findByText(enMessages.auth.wizard.password.rules)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('rejects a mismatched confirmation', async () => {
    mockHappyPath();

    renderWithProviders(<AuthWizard mode="onboarding" />);
    await submitEmail();
    await typeCode('123456');

    const password = await screen.findByLabelText(enMessages.auth.fields.password);
    await userEvent.type(password, 'a-decent-passphrase');
    await userEvent.type(
      screen.getByLabelText(enMessages.auth.fields.passwordConfirm),
      'a-different-passphrase',
    );
    await userEvent.click(
      screen.getByRole('button', { name: enMessages.auth.wizard.actions.finish }),
    );

    expect(await screen.findByText(enMessages.auth.wizard.password.mismatch)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('blocks resending until the cooldown elapses', async () => {
    mockHappyPath();

    renderWithProviders(<AuthWizard mode="onboarding" />);
    await submitEmail();

    const resend = await screen.findByRole('button', { name: /Resend in \d+s/ });
    expect(resend).toBeDisabled();
  });
});
