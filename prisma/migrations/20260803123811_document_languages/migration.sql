-- What a document is written in, most likely first (docs/03 §3.3.10). Hand-written for the same
-- reason as the previous two: `prisma migrate dev` also proposes dropping the raw-SQL search
-- indexes, which the Prisma model does not describe (docs/04 §4.3).
ALTER TABLE "documents" ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT '{}';
