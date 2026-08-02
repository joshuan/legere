import { describe, expect, it, vi } from 'vitest';
import HomePage from './page';

const redirect = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: (url: string): void => {
    redirect(url);
  },
}));

// `/` had been a placeholder landing page since M0 — a dead end with no way into the app, which is
// exactly what a fresh install opens first (docs/10 §10.2).
describe('the root route', () => {
  it('sends the caller to the default screen instead of rendering anything', () => {
    HomePage();

    expect(redirect).toHaveBeenCalledWith('/documents');
  });
});
