# Search quality follow-up proposal

This is a proposal for the next iterations, not an implemented API/UI contract. M84.1 fixes the
reproduced failure; each further iteration needs its own task and contract amendment.

## Observed failure

The production archive contains June 2026 payslips. The composed query
`Расчетный листок июнь 2026` finds them in text mode, but the copied spelling
`Расчетный листок июнь 2026` misses them. With the copied query, hybrid results are utility bills.
Even the composed query puts a semantic-only electricity bill before the two exact title matches.

M84.1 normalizes Unicode on both sides, rebuilds existing indexes, and gives full-query title and
file-name matches priority over incidental prose and vector matches. Synthetic regression fixtures
exercise the production symptom without copying private documents into the repository.

## Proposed order

| Iteration | Result for the person searching | Main implementation constraint |
| --- | --- | --- |
| Russian word forms | `расчетный листок`, `расчётного листка` and `листки` reach the same kind of paper | Add language-aware lexical retrieval alongside `simple`; preserve exact identifiers, multilingual names and quoted phrases. Handle function words such as `за` without requiring them to appear in the title. |
| Period understanding | `июнь 2026`, `за июнь 2026` and `06.2026` express the same requested period | A payroll/billing period can differ from the date printed on the paper. Prefer explicit period fields where available and title/text evidence; do not silently turn every period into a hard `documentDate` filter. Show the interpreted period as an editable filter. |
| Clearer results | Exact matches appear first; a person can distinguish related documents from answers satisfying their request | Keep name-match priority. Evaluate how to separate semantic-only suggestions and how to report that no exact answer was found. Similarity cutoffs need calibration for the configured embedding model. |
| Tolerant input | A small typo or a wrong keyboard layout does not hide an otherwise obvious result | Use bounded fallback retrieval with explicit correction, preserving account numbers, years and short identifiers. Avoid broad fuzzy matching on every query. |

Keep a single useful default search. Advanced text/semantic controls can remain available, but
finding a named document should not require knowing which retrieval engine to select.

## Evaluation before further ranking changes

Build a small judged set of real search intents and expected readable document IDs. Keep private
IDs and corpus content outside version control; use synthetic equivalents for committed tests.
Include named documents, periods, people, file names, identifiers, typos, conceptual requests and
queries with no answer. Evaluate the first result and first five results, wrong-period results,
and latency. Compare lexical, semantic and hybrid retrieval on the same set.

The June payslip regression must remain first in hybrid and text mode, including a decomposed
query, a decomposed stored name, a misleading nearest vector, a one-result limit, and provider
failure. Explicit date/title sorting and authorization remain part of those regression checks.
