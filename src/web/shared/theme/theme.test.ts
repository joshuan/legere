import { describe, expect, it } from 'vitest';
import { theme } from 'antd';
import { paletteFor } from '@joshuan/design-system';
import { legereTheme } from './theme';

// The package tests contrast and component states; the host owns only its brand and preferences.
describe('Legere appearance', () => {
  it.each([false, true])('uses the shared amber identity (dark: %s)', (dark) => {
    const token = theme.getDesignToken(legereTheme(dark, true));
    const palette = paletteFor(dark, 'amber');
    expect(token.colorPrimary).toBe(palette.primary);
    expect(token.colorPrimaryText).toBe(palette.brandText);
    expect(token.colorBgLayout).toBe(palette.page);
    expect(token.motion).toBe(false);
    expect(token.motionDurationMid).toBe('0s');
  });
});
