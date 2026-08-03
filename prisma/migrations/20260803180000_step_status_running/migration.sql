-- A step that is being worked on right now, told apart from one that is merely queued: parsing a
-- document with picture captions takes minutes, and PENDING for that long reads as "stuck"
-- (docs/03 §3.3.10).
--
-- Hand-written, like every migration in this repository: `prisma migrate dev` proposes dropping the
-- raw-SQL search indexes it did not create (docs/04 §4.3).
ALTER TYPE "StepStatus" ADD VALUE 'RUNNING' BEFORE 'DONE';
