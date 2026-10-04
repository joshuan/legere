ALTER TABLE "documents" ADD COLUMN "canonical_storage_key" TEXT;
CREATE TABLE "ocr_runs" (
 "id" UUID PRIMARY KEY, "document_id" UUID NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "actor_id" UUID NOT NULL, "canonical_key" TEXT NOT NULL, "languages" TEXT[] NOT NULL,
 "force" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ocr_runs_document_id_created_at_idx" ON "ocr_runs"("document_id", "created_at" DESC);
CREATE TABLE "ocr_page_images" (
 "id" UUID PRIMARY KEY, "document_id" UUID NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "canonical_key" TEXT NOT NULL, "page_id" UUID NOT NULL, "image_key" TEXT NOT NULL,
 "image_hash" CHAR(64) NOT NULL, "width" INTEGER NOT NULL, "height" INTEGER NOT NULL, "dpi" INTEGER NOT NULL,
 UNIQUE ("document_id", "canonical_key", "page_id")
);
CREATE TABLE "ocr_page_results" (
 "id" UUID PRIMARY KEY, "run_id" UUID NOT NULL REFERENCES "ocr_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "page_id" UUID NOT NULL, "page_number" INTEGER NOT NULL, "provider" TEXT NOT NULL,
 "model" TEXT NOT NULL, "settings_hash" CHAR(64) NOT NULL, "status" TEXT NOT NULL DEFAULT 'QUEUED',
 "attempts" INTEGER NOT NULL DEFAULT 0, "submitted_attempts" INTEGER NOT NULL DEFAULT 0,
 "cached" BOOLEAN NOT NULL DEFAULT false, "image_key" TEXT, "image_hash" CHAR(64),
 "width" INTEGER, "height" INTEGER, "raw_key" TEXT, "result_key" TEXT, "error" TEXT,
 "duration_ms" INTEGER, "lease_token" UUID, "lease_until" TIMESTAMPTZ(6), "completed_at" TIMESTAMPTZ(6),
 UNIQUE ("run_id", "page_id", "provider")
);
CREATE INDEX "ocr_page_results_image_hash_provider_settings_hash_status_idx"
 ON "ocr_page_results"("image_hash", "provider", "settings_hash", "status");
