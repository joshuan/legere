// Shared archive colors (docs/16 §16.2). Neutral working surfaces keep scans in focus;
// green identifies interaction, while status colors retain their own meaning.
export type Palette = {
  page: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  primary: string;
  primaryHover: string;
  primaryActive: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  info: string;
};

export const PAPER: Palette = {
  page: '#F5F7F8',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  border: '#DEE5E8',
  borderStrong: '#BCC9CF',
  text: '#24323B',
  textSecondary: '#63747D',
  primary: '#247463',
  primaryHover: '#2E8874',
  primaryActive: '#195A4D',
  accent: '#936719',
  success: '#34764A',
  warning: '#936719',
  error: '#B43F4D',
  info: '#247463',
};

export const INK: Palette = {
  page: '#121A1E',
  surface: '#1A252B',
  surfaceRaised: '#223139',
  border: '#30434B',
  borderStrong: '#58707B',
  text: '#E7EFF2',
  textSecondary: '#A2B3BA',
  primary: '#73C4AF',
  primaryHover: '#94D7C5',
  primaryActive: '#56A68F',
  accent: '#E0B56C',
  success: '#88C89E',
  warning: '#E0B56C',
  error: '#EC939A',
  info: '#73C4AF',
};

export const paletteFor = (dark: boolean): Palette => (dark ? INK : PAPER);
