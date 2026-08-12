// "ru" → "Russian". Intl knows the list; a table of language names here would go out of date.
//
// Shared by the two clients that have to tell a model what it is looking at: the analyst, so a
// document is described in the language of the archive, and the transcriber, so a page is read in
// the language it was written in (docs/05 §5.5).
export function describeLanguage(tag: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
