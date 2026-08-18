-- Vectors an instance can actually have (docs/04 §4.3, §4.5, docs/12 §12.4).
--
-- The column was sized for a hosted 1536-wide model, and the local ones an operator can actually run
-- are 768 or 1024 — so switching on the second half of hybrid search meant signing up somewhere and
-- sending the archive out. `bge-m3` is the default now: multilingual, 8k of context, 1024 wide.
--
-- Emptying the table is the whole cost, and it is not a loss: a chunk is derived data whose text was
-- cut from the document's own Markdown, which stays where it is. Re-embedding re-reads no scan and
-- calls no Docling — it is one pass of the cheapest step in the pipeline.
DELETE FROM "document_chunks";

DROP INDEX "document_chunks_embedding_idx";
ALTER TABLE "document_chunks" ALTER COLUMN "embedding" TYPE vector(1024);
-- Which embedder made this vector (docs/03 §3.3.11). Two models in one table is a search with no
-- meaning in its distances, and without this column the only way to notice would be to remember.
ALTER TABLE "document_chunks" ADD COLUMN "model" TEXT;
CREATE INDEX "document_chunks_embedding_idx" ON "document_chunks"
  USING hnsw ("embedding" vector_cosine_ops);

-- Everything that was vectorised, and everything that was skipped for want of a provider, is
-- unstarted again: PENDING is what a migration that resets a step leaves behind, and the hourly
-- sweep of docs/05 §5.4 walks it through 200 documents at a time rather than filling the queue in
-- one. FAILED is left exactly as it is — those steps are blocked on their own extraction, and
-- re-enqueueing them would spend the pipeline to arrive at the same failure.
UPDATE "documents"
   SET "vectorization_status" = 'PENDING',
       "skip_reasons" = "skip_reasons" - 'vectorization'
 WHERE "deleted_at" IS NULL
   AND "vectorization_status" IN ('DONE', 'SKIPPED');
