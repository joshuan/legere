import '@testing-library/jest-dom/vitest';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { DocumentImage } from './document-image';

describe('DocumentImage', () => {
  it('replaces an unavailable private artifact and still loads a different document', () => {
    const { rerender } = renderWithProviders(
      <DocumentImage
        src="/api/documents/first/thumb"
        alt="First document"
        width={48}
        height={64}
      />,
    );
    fireEvent.error(screen.getByRole('img', { name: 'First document' }));
    expect(screen.queryByRole('img', { name: 'First document' })).toBeNull();
    expect(
      screen.getByRole('img', { name: enMessages.viewer.previewUnavailable }),
    ).toBeInTheDocument();

    rerender(<DocumentImage src="/api/documents/second/thumb" alt="Second document" />);
    expect(screen.getByRole('img', { name: 'Second document' })).toHaveAttribute(
      'src',
      '/api/documents/second/thumb',
    );
    expect(screen.queryByRole('img', { name: enMessages.viewer.previewUnavailable })).toBeNull();
  });
});
