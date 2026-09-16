-- Existing tokens were read-only. Preserve that authority while enabling narrowly scoped mailbox
-- automation tokens issued, listed and revoked through the ordinary API-token lifecycle.
CREATE TYPE "ApiTokenScope" AS ENUM ('READ', 'DOCUMENTS_INGEST', 'RECEIPTS_INGEST');

ALTER TABLE "api_tokens"
  ADD COLUMN "scope" "ApiTokenScope" NOT NULL DEFAULT 'READ';
