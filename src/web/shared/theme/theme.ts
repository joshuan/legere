import { theme as antdTheme, type ThemeConfig } from 'antd';
import { paletteFor } from './palette';

// The CSS variables the root layout binds the self-hosted faces to (docs/11 §11.15). Referenced by
// name rather than imported so this module stays free of Next specifics and testable as data.
export const FONT_SANS = 'var(--font-sans)';
export const FONT_MONO = 'var(--font-mono)';

// One orchestrated moment per screen, everything else 140 ms (docs/11 §11.15).
export const MOTION_MS = 140;

// The antd theme of docs/11 §11.15. `cssVar` exposes every token as a CSS variable, which is what
// lets the stylesheet dress the page background and the grain without re-declaring a single colour.
export function legereTheme(dark: boolean): ThemeConfig {
  const c = paletteFor(dark);

  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    cssVar: true,
    token: {
      colorPrimary: c.primary,
      colorInfo: c.info,
      colorSuccess: c.success,
      colorWarning: c.warning,
      colorError: c.error,

      colorBgLayout: c.page,
      colorBgContainer: c.surface,
      colorBgElevated: c.surfaceRaised,
      colorBorder: c.borderStrong,
      colorBorderSecondary: c.border,
      colorText: c.text,
      colorTextSecondary: c.textSecondary,
      colorTextDescription: c.textSecondary,

      fontFamily: FONT_SANS,
      fontFamilyCode: FONT_MONO,
      fontSize: 14,
      lineHeight: 1.6,

      borderRadius: 10,
      borderRadiusLG: 14,
      borderRadiusSM: 6,
      controlHeight: 36,
      wireframe: false,

      // Depth is an interaction, not a default: nothing floats at rest.
      boxShadow: dark
        ? '0 1px 2px rgba(0, 0, 0, 0.5), 0 8px 24px -12px rgba(0, 0, 0, 0.7)'
        : '0 1px 2px rgba(46, 38, 24, 0.06), 0 12px 32px -16px rgba(46, 38, 24, 0.24)',
      boxShadowSecondary: dark
        ? '0 6px 20px -8px rgba(0, 0, 0, 0.7)'
        : '0 6px 20px -10px rgba(46, 38, 24, 0.2)',

      motionDurationMid: `${MOTION_MS}ms`,
    },
    components: {
      // No header tokens: the shell is the sider and the content, and nothing sits across the top
      // of a screen (docs/11 §11.1).
      Layout: {
        bodyBg: c.page,
        siderBg: c.surface,
      },
      Menu: {
        itemBg: 'transparent',
        subMenuItemBg: 'transparent',
        itemSelectedBg: dark ? 'rgba(78, 154, 135, 0.16)' : 'rgba(47, 107, 94, 0.1)',
        itemSelectedColor: c.primary,
        itemHoverBg: dark ? 'rgba(237, 231, 218, 0.06)' : 'rgba(30, 27, 22, 0.04)',
        itemHeight: 38,
        itemMarginInline: 8,
        itemBorderRadius: 8,
        iconSize: 16,
      },
      Card: {
        // The strong border, not the hairline: a card sits on the page and has to have an edge you
        // can see (1.5:1 against the page rather than 1.2:1).
        colorBorderSecondary: c.borderStrong,
        paddingLG: 20,
      },
      Table: {
        headerBg: dark ? c.surfaceRaised : '#F0EADD',
        headerColor: c.textSecondary,
        borderColor: c.border,
        rowHoverBg: dark ? 'rgba(237, 231, 218, 0.04)' : 'rgba(47, 107, 94, 0.05)',
      },
      Tag: { borderRadiusSM: 6, defaultBg: dark ? '#262320' : '#EFE9DC' },
      Button: { fontWeight: 500, primaryShadow: 'none', defaultShadow: 'none' },
      Input: {
        activeShadow: `0 0 0 3px ${dark ? 'rgba(78,154,135,0.2)' : 'rgba(47,107,94,0.14)'}`,
      },
      Statistic: { contentFontSize: 26 },
      Segmented: { itemSelectedBg: c.surfaceRaised },
      Tooltip: { colorBgSpotlight: dark ? '#2C2823' : '#2A251C' },
    },
  };
}
