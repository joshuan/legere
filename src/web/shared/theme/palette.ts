// The palette of docs/11 §11.15, as data. Two families that share a temperature: paper is warm, ink
// is a warm black — neither is the neutral grey every dashboard defaults to. Verdigris carries the
// product (a library green, nowhere near antd's blue), brass highlights, and error stays a red no
// one can mistake for either.
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
  page: '#F4F0E7',
  surface: '#FFFDF8',
  surfaceRaised: '#FFFFFF',
  border: '#E3DBC9',
  borderStrong: '#CFC4AC',
  text: '#1E1B16',
  textSecondary: '#6B6355',
  primary: '#2F6B5E',
  primaryHover: '#3A8272',
  primaryActive: '#25564B',
  accent: '#B7873A',
  success: '#5F8D4E',
  warning: '#B7873A',
  error: '#B23B3B',
  info: '#2F6B5E',
};

export const INK: Palette = {
  page: '#141210',
  surface: '#1C1917',
  surfaceRaised: '#232019',
  border: '#33302A',
  borderStrong: '#4A453C',
  text: '#EDE7DA',
  textSecondary: '#A2998A',
  primary: '#4E9A87',
  primaryHover: '#63B39E',
  primaryActive: '#3D7D6D',
  accent: '#C89B4E',
  success: '#7CA96A',
  warning: '#C89B4E',
  error: '#E07070',
  info: '#4E9A87',
};

export const paletteFor = (dark: boolean): Palette => (dark ? INK : PAPER);
