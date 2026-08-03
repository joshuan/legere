-- Why a step was skipped, per step (docs/03 §3.3.10). Hand-written for the same reason as the
-- previous migration: `prisma migrate dev` also proposes dropping the raw-SQL search indexes and the
-- generated column's default, which the Prisma model does not describe (docs/04 §4.3).
ALTER TABLE "documents" ADD COLUMN "skip_reasons" JSONB NOT NULL DEFAULT '{}';
