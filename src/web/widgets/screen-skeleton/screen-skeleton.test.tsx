import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { ScreenSkeleton } from './screen-skeleton';

// What stands in for a screen while one is arriving (docs/11 §11.1, §11.14).
describe('ScreenSkeleton', () => {
  it('is a skeleton of the screen rather than a spinner', () => {
    const { container } = renderWithProviders(<ScreenSkeleton />);

    // The shape of what is coming — a heading and a field of cards — not a turning circle.
    expect(container.querySelectorAll('.ant-skeleton').length).toBeGreaterThan(1);
    expect(container.querySelector('.ant-spin')).toBeNull();
  });

  it('says what it is doing, in words a catalog owns', () => {
    renderWithProviders(<ScreenSkeleton />);

    // Nothing on it is readable, so the region has to say so out loud; the string is localized and
    // the key is English, like everything else (docs/11 §11.14).
    expect(screen.getByRole('status')).toHaveAccessibleName(enMessages.common.loading);
  });
});
