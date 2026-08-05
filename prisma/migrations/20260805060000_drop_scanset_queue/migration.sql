-- The `scanset-merge` queue has no handler any more (docs/05 §5.4, ADR-021), and pg-boss keeps a
-- queue until it is told otherwise: a live instance would carry an orphan queue — and any job left
-- in it — for ever. Dropping it here means an instance upgrades into exactly the queue list the
-- code registers.
--
-- Guarded: pg-boss creates its schema on first boot, so a database that has never run the workers
-- has nothing to clean up.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'job') THEN
    DELETE FROM pgboss.job WHERE name = 'scanset-merge';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'queue') THEN
    DELETE FROM pgboss.queue WHERE name = 'scanset-merge';
  END IF;
END $$;
