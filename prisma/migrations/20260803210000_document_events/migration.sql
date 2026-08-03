-- The history of a document: when it appeared, when it was queued, what each step did, and what a
-- person changed by hand (docs/03 §3.3.18). The row already carries the *current* state of every
-- step; this is the only place that says how it got there — which run failed, what the value was
-- before somebody corrected it, how long a step took.
--
-- Hand-written, like every migration here: `prisma migrate dev` proposes dropping the raw-SQL search
-- indexes it did not create (docs/04 §4.3).
CREATE TYPE "DocumentEventType" AS ENUM (
  'CREATED',
  'FILE_ATTACHED',
  'FILE_MISSING',
  'QUEUED',
  'STEP_STARTED',
  'STEP_FINISHED',
  'META_CHANGED'
);

CREATE TABLE "document_events" (
  "id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "type" "DocumentEventType" NOT NULL,
  -- Null is the pipeline acting on its own; a user id is somebody who pressed something.
  "actor_id" UUID,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "document_events_pkey" PRIMARY KEY ("id")
);

-- Cascade: the log of a document that is physically gone is not evidence of anything. Soft-deleted
-- documents keep theirs, because the row stays (ADR-015).
ALTER TABLE "document_events"
  ADD CONSTRAINT "document_events_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_events"
  ADD CONSTRAINT "document_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The log is always read for one document, newest first.
CREATE INDEX "document_events_document_id_at_idx" ON "document_events" ("document_id", "at" DESC);
