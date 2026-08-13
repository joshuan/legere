-- The mark an admin's deletion leaves on a volume Legere may not write to (docs/03 §3.3.9). Deleting
-- a document is real now (docs/03 §3.3.10, ADR-015 as amended), and a LIBRARY file's bytes are the
-- one part of it that cannot go: they lie on a read-only mount. Without a record that those bytes
-- were deliberately let go, the next scan would find the file, hash it, see no file with that hash
-- and give it a fresh document — the archive undoing the deletion by itself every fifteen minutes.
-- The ref survives the file it pointed at and says EXCLUDED instead.
--
-- Nothing here uses the new value: Postgres forbids using an enum value in the transaction that
-- added it, and Prisma runs one migration per transaction. It is written at runtime, by the delete.
ALTER TYPE "FileRefStatus" ADD VALUE IF NOT EXISTS 'EXCLUDED';
