import { describe, expect, it } from 'vitest';
import { INK, PAPER } from './palette';
import { legereTheme } from './theme';

// The identity of docs/11 §11.15, checked as data: a screen that hardcodes a colour is a screen that
// turns white in dark mode, so the theme has to actually carry both.
describe('legereTheme', () => {
  it('dresses both modes from their own palette', () => {
    const light = legereTheme(false).token;
    const dark = legereTheme(true).token;

    expect(light?.colorPrimary).toBe(PAPER.primary);
    expect(dark?.colorPrimary).toBe(INK.primary);
    // Warm paper and warm black — the page is never the same colour in the two modes.
    expect(light?.colorBgLayout).toBe(PAPER.page);
    expect(dark?.colorBgLayout).toBe(INK.page);
  });

  it('keeps the product colour away from error, so a warning never reads as a failure', () => {
    for (const palette of [PAPER, INK]) {
      expect(palette.primary).not.toBe(palette.error);
      expect(palette.success).not.toBe(palette.primary);
    }
  });

  it('binds the three faces through CSS variables the layout defines', () => {
    const { token } = legereTheme(false);

    expect(token?.fontFamily).toBe('var(--font-sans)');
    expect(token?.fontFamilyCode).toBe('var(--font-mono)');
  });

  it('exposes tokens as CSS variables, which is what the stylesheet dresses the page with', () => {
    expect(legereTheme(false).cssVar).toBe(true);
  });

  it('gives the layout chrome its own surfaces instead of antd defaults', () => {
    const components = legereTheme(true).components;

    expect(components?.Layout?.siderBg).toBe(INK.surface);
    expect(components?.Layout?.bodyBg).toBe(INK.page);
    // Nothing dresses a header, because no screen has one (docs/11 §11.1).
    expect(components?.Layout?.headerBg).toBeUndefined();
  });
});
