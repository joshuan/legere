import { describe, expect, it } from 'vitest';
import { theme } from 'antd';
import { INK, PAPER } from './palette';
import { legereTheme } from './theme';

function luminance(hex: string): number {
  const channel = (start: number): number => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

// The identity of docs/11 §11.15, checked as data: a screen that hardcodes a colour is a screen that
// turns white in dark mode, so the theme has to actually carry both.
describe('legereTheme', () => {
  it('keeps small secondary text readable on working and feedback surfaces in both themes', () => {
    for (const dark of [false, true]) {
      const token = theme.getDesignToken(legereTheme(dark));
      const text = luminance(token.colorTextSecondary);
      for (const background of [
        token.colorBgLayout,
        token.colorBgContainer,
        token.colorInfoBg,
        token.colorSuccessBg,
        token.colorWarningBg,
        token.colorErrorBg,
      ]) {
        const surface = luminance(background);
        const contrast = (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
        expect(contrast, `${dark ? 'dark' : 'light'} text on ${background}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it('dresses both modes from their own palette', () => {
    const light = legereTheme(false).token;
    const dark = legereTheme(true).token;

    expect(light?.colorPrimary).toBe(PAPER.primary);
    expect(dark?.colorPrimary).toBe(INK.primary);
    // Both themes keep their own neutral canvas.
    expect(light?.colorBgLayout).toBe(PAPER.page);
    expect(dark?.colorBgLayout).toBe(INK.page);
  });

  it('keeps the product colour away from error, so a warning never reads as a failure', () => {
    for (const palette of [PAPER, INK]) {
      expect(palette.primary).not.toBe(palette.error);
      expect(palette.success).not.toBe(palette.primary);
    }
  });

  it('binds the two faces through CSS variables the layout defines', () => {
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
    // There is no global desktop header (docs/16 §16.3).
    expect(components?.Layout?.headerBg).toBeUndefined();
  });
});
