-- Document links (docs/03 §3.3.23, ADR-023): an undirected, untyped edge between two documents,
-- made by a person and hard-deleted on removal. The journal gains the two entries that record it.

ALTER TYPE "DocumentEventType" ADD VALUE 'LINKED';
ALTER TYPE "DocumentEventType" ADD VALUE 'UNLINKED';

CREATE TABLE "document_links" (
    "id" UUID NOT NULL,
    "a_id" UUID NOT NULL,
    "b_id" UUID NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_links_a_id_b_id_key" ON "document_links"("a_id", "b_id");
CREATE INDEX "document_links_b_id_idx" ON "document_links"("b_id");

ALTER TABLE "document_links" ADD CONSTRAINT "document_links_a_id_fkey"
  FOREIGN KEY ("a_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_b_id_fkey"
  FOREIGN KEY ("b_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The pair is unordered and the storage says so: one edge cannot exist twice in two spellings,
-- and a row that broke the ordering would be an edge the unique index above cannot see.
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_pair_ordered" CHECK ("a_id" < "b_id");
