import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '../../../shared/contracts/auth';
import { testUser } from '../../../../test/helpers/render';

// Next's own `notFound()` throws to unwind the render; here it records, which is enough to say the
// segment answered 404 (the same shape `src/app/page.test.tsx` uses for `redirect`).
const notFound = vi.fn();
vi.mock('next/navigation', () => ({
  notFound: (): void => {
    notFound();
  },
}));

const answer = vi.fn<() => Promise<UserDto | null>>();
vi.mock('../../_server/current-user', () => ({ currentUser: () => answer() }));

import AdminLayout from './layout';

afterEach(() => {
  vi.clearAllMocks();
});

// 🔒 The admin segment's guard is authorization and stays on the server (docs/08 §8.5, docs/10
// §10.2). The screens below it learn the role from a context the layout provides, and this check
// does not: a role read in the browser is a role a browser can lie about.
describe('the admin segment guard', () => {
  it('answers 404 to a signed-in user who is not an admin', async () => {
    answer.mockResolvedValue(testUser({ role: 'USER' }));

    await AdminLayout({ children: <p>the queue</p> });

    // 404 rather than 403: that the admin area exists at all is not something a regular user needs
    // confirmed (docs/08 §8.1).
    expect(notFound).toHaveBeenCalled();
  });

  it('answers 404 when there is no session behind the request', async () => {
    answer.mockResolvedValue(null);

    await AdminLayout({ children: <p>the queue</p> });

    expect(notFound).toHaveBeenCalled();
  });

  it('lets an admin through to the screen', async () => {
    answer.mockResolvedValue(testUser({ role: 'ADMIN' }));

    render(await AdminLayout({ children: <p>the queue</p> }));

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByText('the queue')).toBeInTheDocument();
  });

  it('asks the server for the role, memoized rather than skipped', async () => {
    answer.mockResolvedValue(testUser({ role: 'ADMIN' }));

    await AdminLayout({ children: <p>the queue</p> });

    // It is no longer a second round trip — `currentUser` is memoized for the render pass — but it
    // is still a question put to the session the API verified.
    expect(answer).toHaveBeenCalledTimes(1);
  });
});
