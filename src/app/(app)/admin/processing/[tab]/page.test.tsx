import { render, screen } from '@testing-library/react';
import { act, Component, Suspense, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import AdminProcessingTabPage from './page';

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({ notFound }));
vi.mock('../../../../../web/screens/admin-queue', () => ({
  AdminProcessingScreen: ({ tab }: { tab?: string }) => <p>{`tab: ${tab ?? 'overview'}`}</p>,
}));

async function drawn(tab: string, wrap: (node: ReactNode) => ReactNode = (node) => node) {
  const params = Promise.resolve({ tab });
  await act(async () => {
    render(
      wrap(
        <Suspense>
          <AdminProcessingTabPage params={params} />
        </Suspense>,
      ),
    );
    await params;
  });
}

describe('the admin processing tab segment', () => {
  it('renders the addressable tab', async () => {
    await drawn('services');
    expect(screen.getByText('tab: services')).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown tab', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await drawn('storage', (node) => <Boundary>{node}</Boundary>);
      expect(screen.getByText('NEXT_NOT_FOUND')).toBeInTheDocument();
      expect(notFound).toHaveBeenCalled();
    } finally {
      report.mockRestore();
    }
  });
});

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render(): ReactNode {
    return this.state.error === null ? this.props.children : <p>{this.state.error.message}</p>;
  }
}
