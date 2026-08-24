import { describe, expect, it } from 'vitest';
import type { CatalogueRow } from '../ports/catalogue-analyst';
import { blockingKey, chunkCatalogue } from './catalogue-chunks';

function row(id: string, name: string): CatalogueRow {
  return { id, name, note: null };
}

// A catalogue of rows nothing relates, so only the cap decides where the cuts fall.
function catalogueOf(count: number): CatalogueRow[] {
  return Array.from({ length: count }, (_, index) =>
    row(`row-${index}`, `Name ${String(index).padStart(3, '0')}`),
  );
}

describe('blockingKey', () => {
  it('reads one name out of two scripts into one key', () => {
    // The pair this whole feature exists to propose (docs/05 §5.6c): the owner of the archive, on a
    // Russian paper and on a boarding pass.
    expect(blockingKey('ШЕРШНЕВ ЕВГЕНИЙ')).toBe('evgeni sersnev');
    expect(blockingKey('SHERSHNEV/EVGENII MR')).toBe('evgeni sersnev');
    expect(blockingKey('Шершнев Евгений')).toBe('evgeni sersnev');
  });

  it('drops what is not a name: punctuation, honorifics, initials and word order', () => {
    // `MR` and `ул.` are two characters; an initial is one. None of them tells two rows apart.
    expect(blockingKey('ул. Красноармейская, 11а')).toBe(blockingKey('Красноармейская 11а'));
    // The same tokens in the other order are the same key: two spellings of a name disagree about
    // word order as readily as about letters.
    expect(blockingKey('Petrović Marija')).toBe(blockingKey('Marija Petrovic'));
  });

  it('folds the diacritics and the doubled letters the two romanizations disagree about', () => {
    // Serbian Latin writes `č`, ICAO writes `ch`, Cyrillic writes `ч`.
    expect(blockingKey('Čačak')).toBe(blockingKey('Chachak'));
    expect(blockingKey('Чачак')).toBe(blockingKey('Chachak'));
    // `Шчербаков`, `Shcherbakov`, `Scherbakov` — one surname, three transcriptions.
    expect(blockingKey('Щербаков')).toBe(blockingKey('Shcherbakov'));
    expect(blockingKey('Scherbakov')).toBe(blockingKey('Shcherbakov'));
  });

  it('keeps a short name rather than keying every short row on nothing', () => {
    // The kinds catalogue is full of two-letter and three-letter words; a floor that emptied them
    // all would pile every kind into one bucket.
    expect(blockingKey('ЖК')).toBe('zk');
    expect(blockingKey('car')).toBe('car');
    expect(blockingKey('!!!')).toBe('');
  });
});

describe('chunkCatalogue', () => {
  it('asks a catalogue that fits in one chunk exactly once, in the order it arrived', () => {
    const rows = catalogueOf(60);
    expect(chunkCatalogue(rows, 60)).toEqual([rows]);
  });

  it('cuts a longer catalogue into equal chunks, none of them over the cap', () => {
    const chunks = chunkCatalogue(catalogueOf(167), 60);

    expect(chunks.map((chunk) => chunk.length)).toEqual([55, 56, 56]);
    // Every row is asked about, and none of them twice.
    const ids = chunks.flatMap((chunk) => chunk.map((chunk_row) => chunk_row.id));
    expect(new Set(ids).size).toBe(167);
  });

  it('puts the same name in two scripts in the same chunk', () => {
    const rows = [
      ...catalogueOf(120),
      row('cyrillic', 'ШЕРШНЕВ ЕВГЕНИЙ'),
      row('latin', 'SHERSHNEV/EVGENII MR'),
    ];

    const chunks = chunkCatalogue(rows, 60);
    const carrying = chunks.filter((chunk) =>
      chunk.some((chunk_row) => chunk_row.id === 'cyrillic' || chunk_row.id === 'latin'),
    );

    // One chunk holds both — which is the whole reason the order is a blocking key and not a name.
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.map((chunk_row) => chunk_row.id)).toEqual(
      expect.arrayContaining(['cyrillic', 'latin']),
    );
  });

  it('cuts the same catalogue the same way twice, whatever order it arrives in', () => {
    const rows = catalogueOf(130);
    const shuffled = [...rows].reverse();

    const first = chunkCatalogue(rows, 60).map((chunk) => chunk.map((chunk_row) => chunk_row.id));
    const second = chunkCatalogue(shuffled, 60).map((chunk) =>
      chunk.map((chunk_row) => chunk_row.id),
    );

    // Deterministic, or the content-keyed cache above it answers a question it never asked.
    expect(second).toEqual(first);
  });
});
