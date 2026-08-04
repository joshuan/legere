-- The analysis names the document now, so a second field has to say who decided a value. That was
-- never a question about types: it is "nobody, the pipeline, or a person", and the enum takes the
-- name of the question rather than of the first field that asked it (docs/03 §3.3.10).
ALTER TYPE "TypeSource" RENAME TO "ValueSource";

-- Every existing document starts at NONE, because a file name is not a title anybody chose. One
-- consequence worth saying out loud: a document renamed by hand before this column existed is
-- indistinguishable from one nobody touched, so a later analysis may rename it — but only if that
-- document is analysed again, which is an explicit reprocess and not something that happens on its
-- own.
ALTER TABLE "documents" ADD COLUMN "title_source" "ValueSource" NOT NULL DEFAULT 'NONE';
