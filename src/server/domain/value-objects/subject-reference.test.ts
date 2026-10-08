import { describe, expect, it } from 'vitest';
import type { Subject } from '../entities/subject';
import { findUniqueSubjectByAddress } from './subject-reference';

function home(id: string, name: string, note: string | null = null): Subject {
  return {
    id,
    kindId: 'housing',
    kind: 'Жильё',
    name,
    note,
    createdAt: new Date('2025-01-01'),
    deletedAt: null,
  };
}

describe('subject address recognition', () => {
  it('recognises the gas bill despite supplier text, script and punctuation differences', () => {
    const flat = home('flat', 'Beograd, Cvetanova ćuprija 24Ђ/2');
    expect(
      findUniqueSubjectByAddress('Cyrus Energy D.O.O., Cvetanova Ćuprija 24 Ć 2', [flat]),
    ).toEqual(flat);
    expect(findUniqueSubjectByAddress('Cvetanoba Ćuprija 24 Ć 2', [flat])).toEqual(flat);
  });

  it('recognises a second street address retained in the existing note after a merge', () => {
    const flat = home(
      'flat',
      'Beograd, Cvetanova ćuprija 24Ђ/2',
      'Also known as: Srđana Kneževića 8,12, stan 2/8',
    );
    expect(
      findUniqueSubjectByAddress('Счёт за дом, Срђана Кнежевића 8, 12, август 2026', [flat]),
    ).toEqual(flat);
  });

  it('does not choose between two apartments at the same address', () => {
    const flats = [
      home('one', 'Srđana Kneževića 8,12, stan 2/8'),
      home('two', 'Srđana Kneževića 8,12, stan 2/9'),
    ];
    expect(findUniqueSubjectByAddress('Srđana Kneževića 8,12', flats)).toBeNull();
  });

  it('requires both street words and building numbers', () => {
    const flat = home('flat', 'Beograd, Cvetanova ćuprija 24Ђ/2');
    expect(findUniqueSubjectByAddress('Cvetanova Ćuprija 25 Ć 2', [flat])).toBeNull();
    expect(findUniqueSubjectByAddress('Cvetanova Ćuprija', [flat])).toBeNull();
  });
});
