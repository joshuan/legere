import '@testing-library/jest-dom/vitest';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentListDto } from '../../../shared/contracts/documents';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { DocumentCard } from './document-card';

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

const base: DocumentListDto = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  title: 'Rental agreement 2026',
  fileCount: 1,
  primaryExt: 'pdf',
  sizeBytes: '2048',
  pageCount: 3,
  documentType: { id: 'bbbbbbbb-2222-4222-8222-222222222222', slug: 'contract', name: 'Contract' },
  availability: 'AVAILABLE',
  processing: false,
  origin: 'LIBRARY',
  hasPreview: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  documentDate: '2026-02-03',
  people: [{ id: 'cccccccc-3333-4333-8333-333333333333', name: 'Ana Petrović' }],
  subjects: [{ id: 'dddddddd-4444-4444-8444-444444444444', name: 'Njegoševa 12' }],
  country: 'ME',
  city: 'Podgorica',
  languages: ['sr', 'en'],
};

describe('DocumentCard', () => {
  it('shows the thumbnail, title, extension and documentType', () => {
    renderWithProviders(<DocumentCard document={base} />);

    const image = screen.getByRole('presentation', { hidden: true });
    // A plain <img> at the API, which 302s to a signed URL (docs/10 §10.8).
    expect(image).toHaveAttribute('src', `/api/documents/${base.id}/thumb`);
    expect(screen.getByText('Rental agreement 2026')).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.getByText('Contract')).toBeInTheDocument();
  });

  it('falls back to an icon while there is no preview yet', () => {
    renderWithProviders(<DocumentCard document={{ ...base, hasPreview: false }} />);

    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });

  it('falls back to an icon when the thumbnail fails to load', () => {
    renderWithProviders(<DocumentCard document={base} />);

    fireEvent.error(screen.getByRole('presentation', { hidden: true }));

    // Better than a broken-image glyph: the artifact may have been swept or the document deleted.
    expect(screen.queryByRole('presentation', { hidden: true })).not.toBeInTheDocument();
  });

  it('badges a document the pipeline is still working on', () => {
    renderWithProviders(<DocumentCard document={{ ...base, processing: true }} />);

    expect(screen.getByText(enMessages.documents.badges.processing)).toBeInTheDocument();
  });

  it('badges a document whose file is gone', () => {
    renderWithProviders(<DocumentCard document={{ ...base, availability: 'UNAVAILABLE' }} />);

    expect(screen.getByText(enMessages.documents.badges.unavailable)).toBeInTheDocument();
  });

  it('tells "some files missing" from "no files at all"', () => {
    const partial = renderWithProviders(
      <DocumentCard document={{ ...base, fileCount: 7, availability: 'PARTIAL' }} />,
    );

    // A document half of which still reads is not a document nobody can open (docs/11 §11.3).
    expect(screen.getByText(enMessages.documents.badges.partial)).toBeInTheDocument();
    expect(screen.queryByText(enMessages.documents.badges.unavailable)).not.toBeInTheDocument();
    partial.unmount();

    renderWithProviders(<DocumentCard document={{ ...base, availability: 'UNAVAILABLE' }} />);
    expect(screen.queryByText(enMessages.documents.badges.partial)).not.toBeInTheDocument();
  });

  // Which of a document's own facts a card draws is the reader's choice (docs/11 §11.3); the card
  // that is not asked keeps the arrangement it has always had.
  describe('the fields it is asked for', () => {
    it('shows the extension and the type by default, and nothing else it could have', () => {
      renderWithProviders(<DocumentCard document={base} />);

      expect(screen.getByText('PDF')).toBeInTheDocument();
      expect(screen.getByText('Contract')).toBeInTheDocument();
      expect(screen.queryByText('2026-02-03')).toBeNull();
      expect(screen.queryByText('Ana Petrović')).toBeNull();
      expect(screen.queryByText('Njegoševa 12')).toBeNull();
      expect(screen.queryByText('Podgorica, ME')).toBeNull();
      expect(screen.queryByText('SR')).toBeNull();
    });

    it('draws the date, the names, the place and the languages when asked for them', () => {
      renderWithProviders(
        <DocumentCard
          document={base}
          fields={['date', 'people', 'subjects', 'place', 'languages']}
        />,
      );

      expect(screen.getByText('2026-02-03')).toBeInTheDocument();
      expect(screen.getByText('Ana Petrović')).toBeInTheDocument();
      expect(screen.getByText('Njegoševa 12')).toBeInTheDocument();
      expect(screen.getByText('Podgorica, ME')).toBeInTheDocument();
      expect(screen.getByText('SR')).toBeInTheDocument();
      expect(screen.getByText('EN')).toBeInTheDocument();
    });

    it('switches off the extension badge and the document type like any other field', () => {
      renderWithProviders(<DocumentCard document={base} fields={[]} />);

      expect(screen.queryByText('PDF')).toBeNull();
      expect(screen.queryByText('Contract')).toBeNull();
      // The title is not a choice, and neither is a state badge: a card may say less about what a
      // document is, never less about what is happening to it (docs/11 §11.3).
      expect(screen.getByText('Rental agreement 2026')).toBeInTheDocument();
    });

    it('says nothing at all about a field the document has no value for', () => {
      renderWithProviders(
        <DocumentCard
          document={{
            ...base,
            documentDate: null,
            people: [],
            subjects: [],
            country: null,
            city: null,
            languages: [],
          }}
          fields={['date', 'people', 'subjects', 'place', 'languages']}
        />,
      );

      // An empty line where a date would be is worse than no line: the card is a glance.
      expect(screen.queryByText('2026-02-03')).toBeNull();
      expect(screen.queryByText('Podgorica, ME')).toBeNull();
    });

    it('names a place by whichever half of it is known', () => {
      renderWithProviders(<DocumentCard document={{ ...base, city: null }} fields={['place']} />);

      expect(screen.getByText('ME')).toBeInTheDocument();
    });
  });

  it('says how many files a document is made of, and only when it is more than one', () => {
    const many = renderWithProviders(<DocumentCard document={{ ...base, fileCount: 7 }} />);

    expect(screen.getByText('7 files')).toBeInTheDocument();
    many.unmount();

    // "1 file" is true of most documents here; a badge that is always there says nothing.
    renderWithProviders(<DocumentCard document={base} />);
    expect(screen.queryByText(/file/)).not.toBeInTheDocument();
  });
});
