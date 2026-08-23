import { describe, expect, it } from 'vitest';
import { foldName } from './name-fold';

describe('foldName', () => {
  it('folds case across alphabets and collapses whitespace', () => {
    // 🔒 The reason this exists: the database's own lower() never touched Cyrillic
    // (docs/03 §3.3.19).
    expect(foldName('ШЕРШНЕВ ЕВГЕНИЙ КОНСТАНТИНОВИЧ')).toBe('шершнев евгений константинович');
    expect(foldName('Жильё')).toBe(foldName('жильё'));
    expect(foldName('CHEVROLET LACETTI')).toBe('chevrolet lacetti');
    expect(foldName('Марија Петровић')).toBe('марија петровић');
    // Two spaces somebody's copy-paste left behind are not a second name.
    expect(foldName('  Шершнёв   Евгений ')).toBe('шершнёв евгений');
  });

  it('reads a decomposed spelling as the composed one', () => {
    // "ё" typed as е + combining diaeresis is the same letter (NFC).
    const decomposed = '\u0436\u0438\u043b\u044c\u0435\u0308';
    expect(foldName(decomposed)).toBe('\u0436\u0438\u043b\u044c\u0451');
  });

  it('keeps what identity must not erase', () => {
    // A mark can be somebody else's name: recognition may fold it, identity may not
    // (docs/05 §5.6c).
    expect(foldName('Petrović')).not.toBe(foldName('Petrovic'));
    expect(foldName('жильё')).not.toBe(foldName('жиле'));
  });
});
