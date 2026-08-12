-- A document row is only ever created together with a job for it: every creation path — an upload, a
-- file the scanner ingested, a document split off another — enqueues `document-process` in the same
-- transaction (docs/05 §5.5). So a new document's steps start QUEUED, and PENDING is left to mean
-- exactly one thing: nothing is scheduled.
ALTER TABLE "documents"
  ALTER COLUMN "canonical_status" SET DEFAULT 'QUEUED',
  ALTER COLUMN "preview_status" SET DEFAULT 'QUEUED',
  ALTER COLUMN "markdown_status" SET DEFAULT 'QUEUED',
  ALTER COLUMN "analysis_status" SET DEFAULT 'QUEUED',
  ALTER COLUMN "vectorization_status" SET DEFAULT 'QUEUED';
