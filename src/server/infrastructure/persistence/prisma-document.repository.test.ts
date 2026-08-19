import { describe, expect, it } from 'vitest';
import type { Viewer } from '../../domain/repositories/document.repository';
import { searchByTextSql } from './prisma-document.repository';

const ADMIN: Viewer = { id: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
const USER: Viewer = { id: '22222222-2222-4222-8222-222222222222', role: 'USER' };

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

// 🔒 SEC-25. The search query is the one piece of SQL in this repository that any signed-in user can
// run as fast as they like, over `documents.markdown` — an unbounded `text` column holding OCR
// output. Its shape is what keeps that affordable, so its shape is asserted here rather than only
// through an end-to-end search that would pass just as happily with the bound removed.
describe('searchByTextSql', () => {
  it('reads the headline out of a bounded prefix, never out of the whole Markdown', () => {
    const sql = searchByTextSql(ADMIN, 'invoice', {}, 50);

    // The only place the column is touched is inside the cut, and the cut is a bound parameter.
    expect(occurrences(sql.text, 'd.markdown')).toBe(1);
    expect(sql.text).toContain('d.markdown\n               ),');
    expect(sql.values).toContain(8000);
    // What ts_headline is handed is that prefix, under its own name — not the column.
    expect(sql.text).toContain('m.excerpt');
    expect(occurrences(sql.text, 'ts_headline')).toBe(1);
  });

  it('runs the headline after the limit, so it costs the page and not the archive', () => {
    const sql = searchByTextSql(ADMIN, 'invoice', {}, 50);

    // Matching, ranking and cutting happen in `matches`; ts_headline reads that result. Written flat
    // it was a projection the planner was free to evaluate for every matching row instead.
    const matches = sql.text.indexOf('matches AS MATERIALIZED');
    const limit = sql.text.indexOf('LIMIT');
    const headline = sql.text.indexOf('ts_headline');
    expect(matches).toBeGreaterThan(-1);
    expect(limit).toBeGreaterThan(matches);
    expect(headline).toBeGreaterThan(limit);
    // MATERIALIZED is the instruction, not a hint: without it the planner may fold the CTE back in
    // and undo both properties.
    expect(sql.text).toContain('q AS MATERIALIZED');
  });

  it('builds the text query once, where it used to be built three times', () => {
    const sql = searchByTextSql(ADMIN, 'invoice', {}, 50);

    // Four readings, not one, and all four inside `q`: the words as typed, the same words with
    // their diacritics removed, and the two ways Cyrillic is read out into Latin (docs/04 §4.3).
    // What this test has always been about is that the parser runs over the caller's words in one
    // place instead of once per consumer — every reader still takes the result from `q`.
    expect(occurrences(sql.text, 'websearch_to_tsquery')).toBe(4);
    // And every reader takes it from that one place: the three name branches, the match, the rank,
    // the headline and one per reason a hit may carry (docs/07 §7.3). What matters is that the
    // parser runs once over the words a person typed, not how many comparisons read the result.
    expect(occurrences(sql.text, 'q.tsq')).toBeGreaterThan(3);
  });

  // 🔒 SEC-25, again: the reasons a hit carries are computed for the answered page, and the one
  // unbounded column among them is read out of the stored vector rather than tokenised a second
  // time — `d.markdown` is touched once in the whole statement, inside the bounded cut.
  it('says why a hit matched without reading the Markdown twice', () => {
    const sql = searchByTextSql(ADMIN, 'invoice', {}, 50);

    expect(occurrences(sql.text, 'd.markdown')).toBe(1);
    expect(sql.text).toContain("ts_filter(d.search_vector, '{b}')");
    // The names are matched where they live, each through the index on that very expression.
    expect(occurrences(sql.text, 'search_tokens(f.name)')).toBe(1);
    expect(occurrences(sql.text, 'search_tokens(p.name)')).toBe(1);
    expect(occurrences(sql.text, 'search_tokens(s.name)')).toBe(1);
  });

  // 🔒 The alphabets meet in the index, never in the query (docs/04 §4.3): `search_tokens` is the
  // one expression both sides are written in, and the words a person typed travel to Postgres
  // exactly as typed. Folding them here instead would match the same documents and cost the
  // highlight, because ts_headline marks the query against the text as it was written.
  it('asks in the alphabet the words were typed in and matches through one expression', () => {
    const sql = searchByTextSql(ADMIN, 'ХТА210700М0596136', {}, 50);

    // The query reaches the tsquery through the separator rule and nothing else.
    expect(sql.text).toContain("websearch_to_tsquery('simple', translate($");
    expect(sql.values).toContain('ХТА210700М0596136');
    expect(sql.text).not.toContain('fold_to_latin');
    expect(sql.text).not.toContain('fold_to_cyrillic');
    // Everything the query is compared against is written in the expression the indexes are built
    // on: the three names, and each column a hit may be credited to.
    expect(occurrences(sql.text, 'search_tokens(')).toBe(9);
  });

  it('sends every value as a bound parameter, including the words a person typed', () => {
    const hostile = "x'; DROP TABLE documents; --";
    const sql = searchByTextSql(USER, hostile, { libraryId: 'a-library', typeId: 'a-type' }, 20);

    // 🔒 Nothing a caller controls reaches the statement text — not the query, not the filters, not
    // the viewer, not the limit. The tagged template is what guarantees it (docs/14 §14.1).
    expect(sql.text).not.toContain('DROP TABLE');
    expect(sql.values).toContain(hostile);
    expect(sql.values).toContain(USER.id);
    expect(sql.values).toContain('a-library');
    expect(sql.values).toContain('a-type');
    expect(sql.values).toContain(20);
  });
});
