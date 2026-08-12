-- The two halves of what used to be one word (docs/03 §3.3.10). `PENDING` meant both "a job exists
-- and a worker will get to it" and "nothing is scheduled at all" — and a migration that resets every
-- step produces the second, so for the two hours before the hourly sweep noticed, the archive read
-- as busy while nothing whatever was going to happen. `QUEUED` is now the first of those, written
-- wherever a job is enqueued; `PENDING` keeps only the second.
--
-- On its own in this migration on purpose: Postgres will not let a new enum value be *used* in the
-- transaction that added it, and Prisma runs one migration per transaction. The defaults that use it
-- follow in the next one.
ALTER TYPE "StepStatus" ADD VALUE IF NOT EXISTS 'QUEUED' AFTER 'PENDING';
