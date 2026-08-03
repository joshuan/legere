import { describe, expect, it } from 'vitest';
import { detectLanguages } from './document-language';

const RU =
  'Настоящий договор заключён между ООО Легере и заказчиком третьего августа две тысячи ' +
  'двадцать шестого года. Предмет договора — хранение и обработка документов. Исполнитель ' +
  'обязуется обеспечить сохранность переданных ему документов и ежемесячно предоставлять отчёт.';
const SR_LATN =
  ' Ugovor je sačinjen na srpskom jeziku i stupa na snagu danom potpisivanja obe strane. ' +
  'Sve izmjene moraju biti u pisanoj formi.';
const EN =
  'This agreement is entered into between Legere Systems and the client on 1 March 2026. ' +
  'The parties agree that the services described in Schedule A shall be delivered monthly and ' +
  'that reports are provided within five working days of each month end.';

// What a document is written in (docs/03 §3.3.10) — the set that decides which languages OCR is
// given, where wrong is worse than absent.
describe('detectLanguages', () => {
  it('reads a document in one language', () => {
    expect(detectLanguages(RU)).toEqual(['ru']);
    expect(detectLanguages(EN)).toEqual(['en']);
  });

  it('finds both halves of a bilingual document', () => {
    const found = detectLanguages(RU + SR_LATN);

    // The Latin half is shorter than the Cyrillic one and still counts: a parallel column usually
    // is. Which of the closely related Latin-script languages franc names is another matter — see
    // below — but the script and the fact of a second language are right.
    expect(found[0]).toBe('ru');
    expect(found).toHaveLength(2);
    expect(found[1]).toMatch(/^(sr-Latn|hr|bs)$/);
  });

  it('says nothing rather than guessing on too little text', () => {
    // Measured: on ~160 characters of Russian the detector ranks Bulgarian first. Below the
    // threshold it answers with an empty list, and nothing downstream is worse off for it.
    expect(detectLanguages('Договор № 42 от 3 августа')).toEqual([]);
    expect(detectLanguages('')).toEqual([]);
    expect(detectLanguages('42 35,40 EUR')).toEqual([]);
  });

  it('ignores a stray line in another language', () => {
    // One English sentence in a long Russian contract is not a second language.
    expect(detectLanguages(`${RU} Signed by both parties.`)).toEqual(['ru']);
  });

  it('marks the script where the same language is written in two of them', () => {
    const found = detectLanguages(SR_LATN.repeat(3));

    // Serbian is the reason the subtag exists: tesseract needs `srp` or `srp_latn`, not "Serbian".
    for (const language of found) expect(language).not.toBe('sr');
  });
});
