import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { theme } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/helpers/render';
import { legereTheme } from '../theme';
import { ThemeProvider, useThemePreference } from './theme-provider';

function ThemeControls() {
  const setPreference = useThemePreference();
  const { token } = theme.useToken();
  return (
    <>
      <output aria-label="page background">{token.colorBgLayout}</output>
      <output aria-label="motion">{String(token.motion)}</output>
      <button type="button" onClick={() => setPreference('DARK')}>
        Dark
      </button>
      <button type="button" onClick={() => setPreference('LIGHT')}>
        Light
      </button>
    </>
  );
}

describe('theme preference', () => {
  it('applies a saved preference and changes the active theme after a successful preference update', async () => {
    renderWithProviders(
      <ThemeProvider preference="DARK">
        <ThemeControls />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText('page background')).toHaveTextContent(
      legereTheme(true).token?.colorBgLayout ?? 'missing',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(screen.getByLabelText('page background')).toHaveTextContent(
      legereTheme(false).token?.colorBgLayout ?? 'missing',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(screen.getByLabelText('page background')).toHaveTextContent(
      legereTheme(true).token?.colorBgLayout ?? 'missing',
    );
  });
});

it('disables component motion when the system requests reduced motion', () => {
  const original = window.matchMedia.bind(window);
  const media = vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    ...original(query),
    matches: query === '(prefers-reduced-motion: reduce)',
  }));
  try {
    renderWithProviders(
      <ThemeProvider>
        <ThemeControls />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText('motion')).toHaveTextContent('false');
  } finally {
    media.mockRestore();
  }
});
