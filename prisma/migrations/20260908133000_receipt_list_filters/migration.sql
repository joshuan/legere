-- Receipt facts that now arrange and narrow the receipt shelf (docs/15 §15.7). The versioned JSON
-- remains the source shown to a reader; these nullable columns are its query projection, replaced
-- atomically whenever extraction is replaced. Existing readings are backfilled in place.
ALTER TABLE "receipts"
  ADD COLUMN "vendor" TEXT,
  ADD COLUMN "purchased_at" DATE,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "total_amount" DOUBLE PRECISION;

UPDATE "receipts"
SET
  "vendor" = CASE
    WHEN jsonb_typeof("extracted" #> '{values,vendor}') = 'string'
      THEN "extracted" #>> '{values,vendor}'
    ELSE NULL
  END,
  "purchased_at" = CASE
    WHEN ("extracted" #>> '{values,purchasedAt}') ~ '^\d{4}-\d{2}-\d{2}$'
      THEN ("extracted" #>> '{values,purchasedAt}')::date
    ELSE NULL
  END,
  "country" = CASE
    WHEN jsonb_typeof("extracted" #> '{values,country}') = 'string'
      THEN upper("extracted" #>> '{values,country}')
    ELSE NULL
  END,
  "currency" = CASE
    WHEN jsonb_typeof("extracted" #> '{values,total,currency}') = 'string'
      THEN upper("extracted" #>> '{values,total,currency}')
    ELSE NULL
  END,
  "total_amount" = CASE
    WHEN jsonb_typeof("extracted" #> '{values,total,amount}') = 'number'
      THEN ("extracted" #>> '{values,total,amount}')::double precision
    ELSE NULL
  END;

CREATE INDEX "receipts_purchased_at_id_idx" ON "receipts" ("purchased_at" DESC, "id" DESC);
CREATE INDEX "receipts_total_amount_id_idx" ON "receipts" ("total_amount" DESC, "id" DESC);
CREATE INDEX "receipts_country_idx" ON "receipts" ("country");
CREATE INDEX "receipts_currency_idx" ON "receipts" ("currency");
