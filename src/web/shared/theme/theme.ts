import { createAppTheme } from '@joshuan/design-system/antd';

export function legereTheme(dark: boolean, reducedMotion = false) {
  return createAppTheme({ dark, reducedMotion, accent: 'green' });
}
