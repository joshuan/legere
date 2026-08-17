import { fireEvent, render, screen } from '@testing-library/react';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Suspense, startTransition, use, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { actAndSettle, renderWithProviders } from '../../test/helpers/render';
import AppLoading from './(app)/loading';

// The routing tree, from the root vitest runs in: `import.meta` is not available under the CommonJS
// output the web project is type-checked against.
const APP_DIR = join(process.cwd(), 'src', 'app');

// Every loading boundary in the routing tree, as a path relative to `src/app`.
function loadingBoundaries(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return loadingBoundaries(full);
    return entry.name === 'loading.tsx' ? [relative(APP_DIR, full)] : [];
  });
}

// Where a loading boundary may live (docs/10 §10.2). A `loading.tsx` is a `<Suspense>` the router
// mounts around the child slots of the segment the file sits in, keyed by the child — so the file's
// position decides which press re-mounts it, and a re-mounted boundary draws its fallback at once.
describe('the loading boundaries of the routing tree', () => {
  it('is one, and it covers the authenticated area', () => {
    expect(loadingBoundaries(APP_DIR)).toEqual([join('(app)', 'loading.tsx')]);
  });

  it('🔒 has none at or below documents/[id], where the viewer moves the slot itself', () => {
    // The viewer switches tabs with router.replace between /documents/:id/preview and
    // /documents/:id/text (docs/11 §11.5). A boundary in `documents/[id]/` would wrap exactly that
    // slot, be re-mounted on every tab press, and blank the document being read — the defect M31
    // exists to remove, one level down. The second test below is that sentence, executed.
    const viewer = join(APP_DIR, '(app)', 'documents', '[id]');

    expect(loadingBoundaries(viewer)).toEqual([]);
  });

  it('🔒 has none at or below admin/queue, which moves its own slot for the same reason', () => {
    // The queue panel switches its four tabs with router.replace between /admin/queue and
    // /admin/queue/:tab (docs/11 §11.13); a boundary here would be re-mounted on every press and
    // blank the table an operator is reading (docs/10 §10.2).
    expect(loadingBoundaries(join(APP_DIR, '(app)', 'admin', 'queue'))).toEqual([]);
  });

  it('draws the screen’s skeleton rather than a spinner', () => {
    const { container } = renderWithProviders(<AppLoading />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(container.querySelector('.ant-spin')).toBeNull();
  });
});

// Why the one boundary is allowed to stand above the viewer, and why a lower one would not be. The
// rule is React's rather than ours, so both halves of it are pinned here.
describe('a Suspense boundary during a navigation', () => {
  it('keeps the document on the screen when the tab below it is replaced', async () => {
    // The tree the viewer actually stands in: the authenticated area's boundary above, mounted and
    // showing a screen, and the tab slot under it with no boundary of its own.
    const arriving = deferred();
    function Harness() {
      const [tab, setTab] = useState<'preview' | 'text'>('preview');
      return (
        <Suspense fallback={<p>the area skeleton</p>}>
          <button type="button" onClick={() => startTransition(() => setTab('text'))}>
            text
          </button>
          {tab === 'preview' ? (
            <p key="preview">the preview tab</p>
          ) : (
            <Arriving key="text" promise={arriving.promise} label="the text tab" />
          )}
        </Suspense>
      );
    }

    render(<Harness />);
    await actAndSettle(() => fireEvent.click(screen.getByRole('button', { name: 'text' })));

    // 🔒 What somebody is reading stays on the screen while the next tab is fetched: React does not
    // take down content an already-mounted boundary has revealed in order to satisfy a transition.
    expect(screen.getByText('the preview tab')).toBeVisible();
    expect(screen.queryByText('the area skeleton')).toBeNull();

    await actAndSettle(() => {
      arriving.resolve();
      return arriving.promise;
    });
    expect(screen.getByText('the text tab')).toBeVisible();
  });

  it('blanks that same document the moment a boundary sits at the tab slot', async () => {
    // The arrangement the structural test above forbids, written out so that the reason is a fact
    // rather than a claim: a `loading.tsx` in documents/[id]/ is a boundary keyed by the tab, so
    // every press brings a new one into being — and a new boundary draws its fallback immediately,
    // over the document being read.
    const arriving = deferred();
    function Harness() {
      const [tab, setTab] = useState<'preview' | 'text'>('preview');
      return (
        <Suspense fallback={<p>the area skeleton</p>}>
          <button type="button" onClick={() => startTransition(() => setTab('text'))}>
            text
          </button>
          <Suspense key={tab} fallback={<p>the tab skeleton</p>}>
            {tab === 'preview' ? (
              <p>the preview tab</p>
            ) : (
              <Arriving promise={arriving.promise} label="the text tab" />
            )}
          </Suspense>
        </Suspense>
      );
    }

    render(<Harness />);
    await actAndSettle(() => fireEvent.click(screen.getByRole('button', { name: 'text' })));

    expect(screen.getByText('the tab skeleton')).toBeVisible();
    expect(screen.queryByText('the preview tab')).toBeNull();

    await actAndSettle(() => {
      arriving.resolve();
      return arriving.promise;
    });
    expect(screen.getByText('the text tab')).toBeVisible();
  });
});

function Arriving({ promise, label }: { promise: Promise<void>; label: string }) {
  use(promise);
  return <p>{label}</p>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}
