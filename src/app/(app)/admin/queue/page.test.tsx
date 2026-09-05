import { describe, expect, it, vi } from 'vitest';
import LegacyAdminQueuePage from './page';

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect }));

describe('the legacy admin queue segment', () => {
  it('redirects to the processing overview', () => {
    expect(() => LegacyAdminQueuePage()).toThrow('NEXT_REDIRECT:/admin/processing');
    expect(redirect).toHaveBeenCalledWith('/admin/processing');
  });
});
