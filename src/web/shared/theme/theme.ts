import { theme as antdTheme, type ThemeConfig } from 'antd';
import { paletteFor } from './palette';

// The CSS variables the root layout binds the self-hosted faces to (docs/11 §11.15). Referenced by
// name rather than imported so this module stays free of Next specifics and testable as data.
export const FONT_SANS = 'var(--font-sans)';
export const FONT_MONO = 'var(--font-mono)';

// Restrained feedback for direct interaction (docs/16 §16.2).
export const MOTION_MS = 140;

// The antd theme of docs/11 §11.15. `cssVar` exposes every token as a CSS variable, which is what
// keeps shared layout rules and floating overlays in sync with both themes.
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

      // The default palette generator makes pale surfaces muddy when the seed is a dark,
      // accessible accent. Keep light feedback surfaces quiet and their text readable.
      ...(!dark && {
        colorPrimaryBg: '#EAF4F0',
        colorPrimaryBgHover: '#DCEEE6',
        colorPrimaryBorder: '#AFCFC4',
        colorPrimaryBorderHover: '#87B8A8',
        colorInfoBg: '#F2F9F6',
        colorInfoBgHover: '#E3F1EB',
        colorInfoBorder: '#B7D8CD',
        colorSuccessBg: '#F1F9F3',
        colorSuccessBgHover: '#E0EFE4',
        colorSuccessBorder: '#BFDDC7',
        colorWarningBg: '#FCF8EE',
        colorWarningBgHover: '#F7EDD4',
        colorWarningBorder: '#E7D6AE',
        colorErrorBg: '#FDF5F6',
        colorErrorBgHover: '#F6E1E5',
        colorErrorBorder: '#ECC5CC',
      }),

      colorBgLayout: c.page,
      colorBgContainer: c.surface,
      colorBgElevated: c.surfaceRaised,
      colorBorder: c.borderStrong,
      colorBorderSecondary: c.border,
      colorText: c.text,
      colorTextSecondary: c.textSecondary,
      colorTextDescription: c.textSecondary,
      colorTextDisabled: c.textSecondary,
      colorTextPlaceholder: c.textSecondary,

      fontFamily: FONT_SANS,
      fontFamilyCode: FONT_MONO,
      fontSize: 14,
      lineHeight: 1.5,

      borderRadius: 6,
      borderRadiusLG: 8,
      borderRadiusSM: 4,
      controlHeight: 36,
      controlHeightSM: 28,
      controlHeightLG: 44,
      colorTextLightSolid: dark ? c.page : c.surface,
      fontSizeHeading1: 28,
      fontSizeHeading2: 24,
      fontSizeHeading3: 20,
      fontSizeHeading4: 16,
      fontSizeHeading5: 14,
      wireframe: false,

      // Depth is an interaction, not a default: nothing floats at rest.
      boxShadow: dark
        ? '0 1px 2px rgba(0, 0, 0, 0.5), 0 8px 24px -12px rgba(0, 0, 0, 0.7)'
        : '0 1px 2px rgba(24, 45, 54, 0.06), 0 12px 32px -16px rgba(24, 45, 54, 0.20)',
      boxShadowSecondary: dark
        ? '0 6px 20px -8px rgba(0, 0, 0, 0.7)'
        : '0 6px 20px -10px rgba(24, 45, 54, 0.16)',

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
        itemSelectedBg: dark ? 'rgba(115, 196, 175, 0.12)' : 'rgba(36, 116, 99, 0.08)',
        itemSelectedColor: c.primary,
        itemHoverBg: dark ? 'rgba(231, 239, 242, 0.05)' : 'rgba(36, 50, 59, 0.04)',
        itemHeight: 36,
        itemMarginInline: 8,
        itemBorderRadius: 6,
        iconSize: 16,
      },
      Card: {
        colorBorderSecondary: c.border,
        paddingLG: 20,
        headerHeight: 48,
        headerFontSize: 16,
      },
      Table: {
        headerBg: c.page,
        headerColor: c.textSecondary,
        borderColor: c.border,
        cellPaddingBlock: 12,
        cellPaddingInline: 16,
        cellPaddingBlockSM: 10,
        cellPaddingInlineSM: 12,
        rowHoverBg: dark ? 'rgba(231, 239, 242, 0.04)' : 'rgba(36, 116, 99, 0.035)',
      },
      Tag: { borderRadiusSM: 4, defaultBg: c.page },
      Button: { fontWeight: 500, primaryShadow: 'none', defaultShadow: 'none' },
      Input: {
        activeShadow: `0 0 0 3px ${dark ? 'rgba(115,196,175,0.18)' : 'rgba(36,116,99,0.12)'}`,
      },
      Statistic: { contentFontSize: 26 },
      Segmented: { itemSelectedBg: c.surfaceRaised },
      Tooltip: { colorBgSpotlight: dark ? c.surfaceRaised : c.text },
      Form: { itemMarginBottom: 20, verticalLabelPadding: '0 0 6px', labelColor: c.text },
      Descriptions: { labelColor: c.textSecondary },
      Tabs: { horizontalItemPadding: '12px 0', horizontalItemGutter: 24, titleFontSize: 14 },
      Modal: { borderRadiusLG: 12, titleFontSize: 18 },
      Drawer: { footerPaddingBlock: 16, footerPaddingInline: 20 },
      DatePicker: { cellWidth: 32, cellHeight: 32 },
    },
  };
}
