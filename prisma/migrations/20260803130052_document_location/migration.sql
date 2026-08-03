-- Where a document belongs (docs/03 §3.3.10). Hand-written: `prisma migrate dev` also proposes
-- dropping the raw-SQL search indexes, which the Prisma model does not describe (docs/04 §4.3).
ALTER TABLE "documents" ADD COLUMN "country" TEXT;
ALTER TABLE "documents" ADD COLUMN "city" TEXT;
