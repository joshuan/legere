'use client';

import { ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import ruRU from 'antd/locale/ru_RU';
import { useLocale } from 'next-intl';
import { createContext, use, useState, type ReactNode } from 'react';
import type { Theme } from '../../../shared/contracts/enums';
import { legereTheme } from '../theme';

import { useSystemAppearance } from '@joshuan/design-system/react';

const ThemePreferenceContext = createContext<(preference: Theme) => void>(() => {});

// The shell supplies the signed-in preference; settings can apply a successful save immediately.
export function useThemePreference(): (preference: Theme) => void {
  return use(ThemePreferenceContext);
}

export function ThemeProvider({
  children,
  preference = 'SYSTEM',
}: {
  children: ReactNode;
  preference?: Theme;
}) {
  const locale = useLocale();
  const [selectedPreference, setSelectedPreference] = useState(preference);
  const system = useSystemAppearance();
  const dark = selectedPreference === 'DARK' || (selectedPreference === 'SYSTEM' && system.dark);
  const appearance = legereTheme(dark, system.reducedMotion);

  return (
    <ThemePreferenceContext value={setSelectedPreference}>
      <ConfigProvider
        locale={locale === 'ru' ? ruRU : enUS}
        theme={appearance}
        modal={{ styles: { wrapper: { colorScheme: dark ? 'dark' : 'light' } } }}
      >
        {children}
      </ConfigProvider>
    </ThemePreferenceContext>
  );
}
