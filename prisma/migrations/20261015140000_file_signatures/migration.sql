CREATE TABLE "file_signatures" (
  "id" UUID NOT NULL,
  "file_id" UUID NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "original_hash" CHAR(64) NOT NULL,
  "name" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "report" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "file_signatures_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "file_signatures_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "file_signatures_file_id_content_hash_key" ON "file_signatures"("file_id", "content_hash");
