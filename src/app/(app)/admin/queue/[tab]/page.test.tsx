import { describe, expect, it, vi } from 'vitest';
import LegacyAdminQueueTabPage from './page';

const { notFound, redirect } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));
vi.mock('next/navigation', () => ({ notFound, redirect }));

describe('the legacy admin queue tab segment', () => {
  it('redirects every valid tab to the exact processing tab', async () => {
    await expect(
      LegacyAdminQueueTabPage({ params: Promise.resolve({ tab: 'services' }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/admin/processing/services');
    expect(redirect).toHaveBeenCalledWith('/admin/processing/services');
  });

  it('keeps rejecting unknown old tab addresses', async () => {
    await expect(
      LegacyAdminQueueTabPage({ params: Promise.resolve({ tab: 'storage' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });
});
