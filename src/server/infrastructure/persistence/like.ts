// 🔒 LIKE metacharacters in a browsed path (docs/05 §5.1, docs/07 §7.3).
//
// A folder comes straight off `?path=` and `%`, `_` and the escape character itself are wildcards to
// `LIKE`, not letters. Left alone, `?path=%` becomes the pattern `%/%` — every path in the library —
// so the folder listing answers for a place the caller is not in, and the companion
// `substring(path from char_length(path) + 2)`, which counts the *unescaped* folder, then cuts each
// of those paths at an offset that means nothing. Not an access-control bypass: the library was
// checked first and every row it returns is one click away regardless. It is a wrong answer, and a
// sequential scan of the whole table on the way to it.
//
// Escaped rather than rewritten as a `path >= x AND path < y` prefix range, which would also be
// index-friendly: a range is only equivalent to a prefix when the column orders byte-wise, and
// Legere pins no database collation — under glibc or ICU, punctuation such as `/` carries no weight
// at the primary level, so the bracket would silently take in or leave out rows. Escaping keeps
// `LIKE`'s pattern semantics exactly as they are, needs no migration and no second index, and leaves
// the `substring` offset in agreement by construction.
const LIKE_ESCAPE = '\\';

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => LIKE_ESCAPE + character);
}

// Everything below `folder`, as a `LIKE` pattern to be used with `ESCAPE '\'`. The volume root is
// not asked this way — it has no prefix at all — so the callers test for it separately.
export function folderPrefixPattern(folder: string): string {
  return `${escapeLike(folder)}/%`;
}
