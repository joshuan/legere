import { render, screen } from '@testing-library/react';
import { act, Component, Suspense, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import AdminQueueTabPage from './page';

// `notFound()` throws in Next; here it only has to be observable. Hoisted, because `vi.mock` is
// lifted above the file's own declarations.
const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({ notFound }));

// The screen has a suite of its own; what is under test here is the segment — which tab it hands
// over, and what it does with an address that names none.
vi.mock('../../../../../web/screens/admin-queue', () => ({
  AdminQueueScreen: ({ tab }: { tab?: string }) => <p>{`tab: ${tab ?? 'overview'}`}</p>,
}));

// The segment reads its parameters with `use`, so it suspends for a microtask: the render and the
// resolution have to happen inside one `act`, or the wake-up lands outside React's knowledge.
async function drawn(tab: string, wrap: (node: ReactNode) => ReactNode = (node) => node) {
  const params = Promise.resolve({ tab });
  await act(async () => {
    render(
      wrap(
        <Suspense>
          <AdminQueueTabPage params={params} />
        </Suspense>,
      ),
    );
    await params;
  });
}

// /admin/queue/:tab (docs/11 §11.13). Synchronous and validated where the cookie is: an address
// nobody can be on is a wrong address, not a reason to guess which tab was meant.
describe('the admin queue tab segment', () => {
  it('hands the screen the tab the address names', async () => {
    await drawn('services');

    expect(screen.getByText('tab: services')).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
  });

  it('answers 404 for a tab this screen does not have', async () => {
    // React reports caught render errors to stderr in development. This one is the behavior under
    // test, so keep the expected diagnostic local to the assertion instead of flooding the run.
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await drawn('storage', (node) => <Boundary>{node}</Boundary>);

      // The throw travels to the boundary Next puts above every segment; here it is this one.
      expect(screen.getByText('NEXT_NOT_FOUND')).toBeInTheDocument();
      expect(notFound).toHaveBeenCalled();
    } finally {
      report.mockRestore();
    }
  });
});

// The nearest thing to Next's own error handling that a unit test needs: something that catches what
// the segment throws and says what it was.
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render(): ReactNode {
    return this.state.error === null ? this.props.children : <p>{this.state.error.message}</p>;
  }
}
