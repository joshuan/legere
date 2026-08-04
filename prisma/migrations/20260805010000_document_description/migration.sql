-- What a document is, for somebody who has never seen it: what it is, between whom, what for
-- (docs/03 §3.3.10). Read by the analysis where the field is empty, and correctable by hand.
--
-- Nullable and empty for everything already here: a description is a real blank, and the analysis
-- fills it the next time it runs.
ALTER TABLE "documents" ADD COLUMN "description" TEXT;
