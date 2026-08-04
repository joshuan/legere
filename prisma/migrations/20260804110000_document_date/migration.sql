-- The date written on the document: signed, issued, departed. Not `created_at`, which is when Legere
-- first saw the file — a contract from 2019 scanned yesterday is a 2019 document, and sorting a
-- shelf by when somebody got round to scanning it is sorting by nothing (docs/03 §3.3.10).
--
-- DATE, not TIMESTAMPTZ: a signing has no clock, and storing midnight in some zone would invent a
-- precision the paper does not have — and shift the date for readers in another one.
--
-- Hand-written, like every migration here: `prisma migrate dev` proposes dropping the raw-SQL search
-- indexes it did not create (docs/04 §4.3).
ALTER TABLE "documents" ADD COLUMN "document_date" DATE;

-- Browsing by year and "what happened in March" both read this, newest first (docs/07 §7.3).
CREATE INDEX "documents_document_date_idx" ON "documents" ("document_date" DESC NULLS LAST);
