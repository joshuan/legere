import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, type RenderResult } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import messages from '../../messages/en.json';
import type { UserDto } from '../../src/shared/contracts/auth';
import { CurrentUserProvider } from '../../src/web/entities/user';
import { UploadQueueProvider } from '../../src/web/features/upload-queue';
import { SearchOverlayProvider } from '../../src/web/widgets/search-overlay';

// Somebody signed in, because in the application there always is: the (app) layout redirects a
// caller without a session to /login before any screen renders (docs/10 §10.2). Overrides let a test
// say which somebody — an admin, or the owner of the collection on the screen.
export function testUser(overrides: Partial<UserDto> = {}): UserDto {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    email: 'reader@legere.local',
    displayName: 'Reader',
    role: 'USER',
    language: 'EN',
    theme: 'SYSTEM',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export const TEST_USER: UserDto = testUser();
export const TEST_ADMIN: UserDto = testUser({
  id: '88888888-8888-4888-8888-888888888888',
  email: 'admin@legere.local',
  displayName: 'Ada',
  role: 'ADMIN',
});

// Renders a component with the same providers the app gives it (docs/10 §10.4), minus SSR-only
// pieces. Retries are off so a failing request surfaces immediately instead of after backoff.
//
// The upload queue and the search overlay are among them: the authenticated layout mounts both
// around every screen (docs/11 §11.3a, §11.1a), so a screen that hands the queue files — or a shell
// that raises the overlay — has one here too. So is the signed-in user: since M31.1 a screen reads
// the role, and its own reader's id, from the context the layout provides rather than from a prop a
// page fetched for it (docs/10 §10.2).
export function renderWithProviders(
  ui: ReactElement,
  { user = TEST_USER }: { user?: UserDto } = {},
): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale="en" messages={messages}>
        <AntdApp>
          <QueryClientProvider client={queryClient}>
            <CurrentUserProvider user={user}>
              <SearchOverlayProvider>
                <UploadQueueProvider>{children}</UploadQueueProvider>
              </SearchOverlayProvider>
            </CurrentUserProvider>
          </QueryClientProvider>
        </AntdApp>
      </NextIntlClientProvider>
    );
  }

  return render(ui, { wrapper: Wrapper });
}

// Work that makes something suspend — a segment reading its parameters, a press that starts a
// navigation, the answer that ends one — inside an **async** `act` scope. React parks the retry of
// anything that suspends inside a synchronous scope until that scope is awaited, and says so in a
// warning; this is where it gets awaited.
export async function actAndSettle(work: () => unknown): Promise<void> {
  await act(async () => {
    await work();
  });
}

export { messages as enMessages };
