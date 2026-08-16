import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { testUser } from '../../../../test/helpers/render';
import { CurrentUserProvider, useCurrentUser, useIsAdmin } from './current-user';

function Screen() {
  const user = useCurrentUser();
  return <p>{`${user.displayName} ${useIsAdmin() ? 'may administer' : 'may not administer'}`}</p>;
}

// How a screen learns who is reading it (docs/10 §10.2). It used to be a prop, handed down by a page
// that had fetched /api/me for the purpose — one loopback call per navigation, on top of the one the
// layout above had already made.
describe('the current user in the client tree', () => {
  it('carries the role from the layout to the screen', () => {
    render(
      <CurrentUserProvider user={testUser({ displayName: 'Ada', role: 'ADMIN' })}>
        <Screen />
      </CurrentUserProvider>,
    );

    expect(screen.getByText('Ada may administer')).toBeInTheDocument();
  });

  it('says plainly that somebody is not an admin rather than leaving it open', () => {
    render(
      <CurrentUserProvider user={testUser({ displayName: 'Bo', role: 'USER' })}>
        <Screen />
      </CurrentUserProvider>,
    );

    expect(screen.getByText('Bo may not administer')).toBeInTheDocument();
  });

  it('refuses to answer outside the authenticated area instead of inventing a reader', () => {
    // A screen rendered without the provider is a screen outside the (app) layout, where there is no
    // session at all; guessing a role there is exactly the mistake this context must not make.
    expect(() => render(<Screen />)).toThrow(/CurrentUserProvider/);
  });
});
