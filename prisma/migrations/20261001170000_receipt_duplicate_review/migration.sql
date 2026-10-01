CREATE TABLE "receipt_reviews" (
  "id" UUID PRIMARY KEY,
  "position" BIGSERIAL NOT NULL UNIQUE,
  "owner_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actor_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "first_id" UUID NOT NULL,
  "second_id" UUID NOT NULL,
  "revision" CHAR(64) NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "reverse" BOOLEAN NOT NULL DEFAULT false,
  "pair" JSONB NOT NULL,
  "result_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undone_at" TIMESTAMPTZ(6),
  CONSTRAINT "receipt_review_pair_order" CHECK ("first_id" < "second_id"),
  CONSTRAINT "receipt_review_action" CHECK ("action" IN ('DISMISS', 'KEEP_FIRST', 'KEEP_SECOND', 'MERGE')),
  CONSTRAINT "receipt_review_order" CHECK (NOT "reverse" OR "action" = 'MERGE')
);
CREATE INDEX "receipt_reviews_owner_id_position_idx" ON "receipt_reviews" ("owner_id", "position" DESC);
CREATE INDEX "receipt_reviews_first_id_second_id_position_idx" ON "receipt_reviews" ("first_id", "second_id", "position" DESC);
CREATE INDEX "receipt_reviews_result_id_idx" ON "receipt_reviews" ("result_id");
CREATE INDEX "receipts_purchased_at_currency_total_amount_id_idx" ON "receipts" ("purchased_at", "currency", "total_amount", "id");
