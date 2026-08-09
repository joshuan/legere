import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { PasswordCard } from './password-card';

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// The password card on /settings (docs/11 §11.9, docs/08 §8.1.6a).
describe('PasswordCard', () => {
  it('sends the current and the new password, and reports what it ended', async () => {
    let sent: unknown = null;
    server.use(
      http.post('/api/me/password', async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(envelope({ revoked: 2 }));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<PasswordCard />);

    await user.type(
      screen.getByLabelText(enMessages.settings.password.current),
      'a-decent-passphrase',
    );
    await user.type(
      screen.getByLabelText(enMessages.settings.password.next),
      'an-even-better-passphrase',
    );
    await user.type(
      screen.getByLabelText(enMessages.settings.password.confirm),
      'an-even-better-passphrase',
    );
    await user.click(screen.getByRole('button', { name: enMessages.settings.password.submit }));

    await waitFor(() =>
      expect(sent).toEqual({
        currentPassword: 'a-decent-passphrase',
        newPassword: 'an-even-better-passphrase',
      }),
    );
    // 🔒 The confirmation never leaves the browser: the server has no use for a second copy.
    expect(JSON.stringify(sent)).not.toContain('confirmPassword');
  });

  it('refuses to submit when the repeat does not match', async () => {
    let called = false;
    server.use(
      http.post('/api/me/password', () => {
        called = true;
        return HttpResponse.json(envelope({ revoked: 0 }));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<PasswordCard />);

    await user.type(
      screen.getByLabelText(enMessages.settings.password.current),
      'a-decent-passphrase',
    );
    await user.type(
      screen.getByLabelText(enMessages.settings.password.next),
      'an-even-better-passphrase',
    );
    await user.type(screen.getByLabelText(enMessages.settings.password.confirm), 'a typo');
    await user.click(screen.getByRole('button', { name: enMessages.settings.password.submit }));

    expect(
      await screen.findByText(enMessages.settings.password.confirmMismatch),
    ).toBeInTheDocument();
    expect(called).toBe(false);
  });
});
