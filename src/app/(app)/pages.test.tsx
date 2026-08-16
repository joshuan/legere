import { render, screen } from '@testing-library/react';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { actAndSettle } from '../../../test/helpers/render';

// The screens are not what this file is about; each is a marker that says which page composed it and
// with what. What is under test is the composing itself: that it happens on the press.
vi.mock('../../web/screens/documents', () => ({
  DocumentsScreen: () => <p>the documents grid</p>,
}));
vi.mock('../../web/screens/document-viewer', () => ({
  DocumentViewerScreen: ({ id, tab }: { id: string; tab?: string }) => (
    <p>{`viewer ${id} ${tab ?? ''}`}</p>
  ),
}));
vi.mock('../../web/screens/collection-detail', () => ({
  CollectionDetailScreen: ({ id }: { id: string }) => <p>{`collection ${id}`}</p>,
}));
vi.mock('../../web/screens/people', () => ({ PeopleScreen: () => <p>the people</p> }));
vi.mock('../../web/screens/subjects', () => ({ SubjectsScreen: () => <p>the subjects</p> }));
vi.mock('../../web/screens/subject-kinds', () => ({
  SubjectKindsScreen: () => <p>the subject kinds</p>,
}));
vi.mock('../../web/screens/document-types', () => ({
  DocumentTypesScreen: () => <p>the document types</p>,
}));

const notFound = vi.fn();
vi.mock('next/navigation', () => ({
  notFound: (): void => {
    notFound();
  },
}));

import CollectionPage from './collections/[id]/page';
import DocumentTypesPage from './document-types/page';
import DocumentTabPage from './documents/[id]/[tab]/page';
import DocumentPage from './documents/[id]/page';
import DocumentsPage from './documents/page';
import PeoplePage from './people/page';
import SubjectKindsPage from './subject-kinds/page';
import SubjectsPage from './subjects/page';

const PAGES = [
  ['/documents', DocumentsPage],
  ['/documents/:id', DocumentPage],
  ['/documents/:id/:tab', DocumentTabPage],
  ['/collections/:id', CollectionPage],
  ['/people', PeoplePage],
  ['/subjects', SubjectsPage],
  ['/subject-kinds', SubjectKindsPage],
  ['/document-types', DocumentTypesPage],
] as const;

// This file's own directory, from the root vitest runs in: `import.meta` is not available under
// the CommonJS output the web project is type-checked against.
const PAGE_DIR = join(process.cwd(), 'src', 'app', '(app)');

const SOURCES = [
  './documents/page.tsx',
  './documents/[id]/page.tsx',
  './documents/[id]/[tab]/page.tsx',
  './collections/[id]/page.tsx',
  './people/page.tsx',
  './subjects/page.tsx',
  './subject-kinds/page.tsx',
  './document-types/page.tsx',
];

// The pages of the authenticated area (docs/10 §10.2). Each used to open with `await currentUser()`
// — a loopback call to /api/me the layout above had already made — so the router had nothing to
// commit until the server had answered twice and a press on a card did nothing at all.
describe('the pages of the authenticated area', () => {
  it('are synchronous server components, so the segment has nothing to await', () => {
    for (const [route, page] of PAGES) {
      // Named in the assertion so a failure says which page went back to being async.
      expect(`${route} is ${page.constructor.name}`).toBe(`${route} is Function`);
    }
  });

  it('do not ask who is signed in: not one of them so much as imports the guard', async () => {
    for (const source of SOURCES) {
      const text = await readFile(join(PAGE_DIR, source), 'utf8');
      expect(`${source}: ${String(text.includes('current-user'))}`).toBe(`${source}: false`);
    }
  });

  it('draws a screen with no parameters to read the moment it is called', () => {
    // No Suspense boundary and no await anywhere: calling the page returns an element that renders.
    render(DocumentsPage());

    expect(screen.getByText('the documents grid')).toBeInTheDocument();
  });

  it('reads a document viewer out of the address alone', async () => {
    await actAndSettle(() =>
      render(
        <Suspense fallback={<p>waiting</p>}>
          <DocumentTabPage params={Promise.resolve({ id: 'doc-1', tab: 'text' })} />
        </Suspense>,
      ),
    );

    expect(screen.getByText('viewer doc-1 text')).toBeInTheDocument();
  });

  it('lands on the preview when the address carries no tab', async () => {
    await actAndSettle(() =>
      render(
        <Suspense fallback={<p>waiting</p>}>
          <DocumentPage params={Promise.resolve({ id: 'doc-1' })} />
        </Suspense>,
      ),
    );

    expect(screen.getByText('viewer doc-1 preview')).toBeInTheDocument();
  });

  it('answers 404 to a tab that is not one', async () => {
    await actAndSettle(() =>
      render(
        <Suspense fallback={<p>waiting</p>}>
          <DocumentTabPage params={Promise.resolve({ id: 'doc-1', tab: 'nonsense' })} />
        </Suspense>,
      ),
    );

    expect(notFound).toHaveBeenCalled();
  });

  it('hands a collection its id and nothing else — who is reading comes from the context', async () => {
    await actAndSettle(() =>
      render(
        <Suspense fallback={<p>waiting</p>}>
          <CollectionPage params={Promise.resolve({ id: 'col-1' })} />
        </Suspense>,
      ),
    );

    expect(screen.getByText('collection col-1')).toBeInTheDocument();
  });
});
