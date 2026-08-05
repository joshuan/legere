import { z } from 'zod';

// What the analysis writes in (docs/03 §3.3.21, docs/05 §5.5). An archive whose titles are Russian
// and whose descriptions are English is an archive that reads as two archives; the instance says
// which language the machine uses, once, for everything it writes: the title, the description, and
// the names it invents for people, things and their kinds.
//
// Empty means "the language of the document", which is what it did before the setting existed.
export const analysisLanguageSchema = z.object({
  // A BCP-47 tag or empty. Kept as a tag rather than a name so the prompt can say it in the
  // language's own words and the UI can show it in the reader's.
  language: z.string().trim().max(12),
});
export type AnalysisLanguageDto = z.infer<typeof analysisLanguageSchema>;

export const updateAnalysisLanguageRequestSchema = analysisLanguageSchema;
export type UpdateAnalysisLanguageRequest = z.infer<typeof updateAnalysisLanguageRequestSchema>;
