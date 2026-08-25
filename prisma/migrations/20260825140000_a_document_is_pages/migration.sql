-- A document is an ordered list of pages (ADR-025, docs/03 §3.3.17, docs/04 §4.1).
--
-- `document_pages` replaces `document_files` as the thing that is ordered: an entry names the file
-- it is read from, which page of that file, which way up it lies and how much of it is paper. The
-- crop and the turn move here off the file, because they are answers about a page of one document
-- and never about the bytes — a twenty-page scan has three pages lying sideways and not twenty, and
-- two documents may read one photograph and want different parts of it.
--
-- Every existing row becomes pages, in the order it was read in: a stored `page_order` becomes that
-- many entries in that order, a file with a counted `page_count` becomes its pages, and anything
-- nobody has counted becomes **one entry with a NULL page index** — "this file, whole, in the order
-- it arrived" — which the first canonical build expands (docs/05 §5.5 step 1). Each file's crop
-- lands on the page it belonged to, and each stored page turn on the page it named.
--
-- The unique index on `document_files.file_id` goes with the table: a file may now be read by pages
-- of any number of documents, which is the point of ADR-025.

CREATE TABLE "document_pages" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "file_id" UUID NOT NULL,
    "page_index" INTEGER,
    "turn" JSONB,
    "crop" JSONB,
    "crop_source" "ValueSource" NOT NULL DEFAULT 'NONE',

    CONSTRAINT "document_pages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_pages_document_id_position_key"
    ON "document_pages"("document_id", "position");

-- Not unique, unlike the index it replaces: one file, many documents (ADR-025).
CREATE INDEX "document_pages_file_id_idx" ON "document_pages"("file_id");

ALTER TABLE "document_pages"
    ADD CONSTRAINT "document_pages_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_pages"
    ADD CONSTRAINT "document_pages_file_id_fkey"
    FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- >>> every existing row into pages (the statement the migration test re-runs over its own fixtures)
INSERT INTO "document_pages" ("id", "document_id", "position", "file_id", "page_index", "turn", "crop", "crop_source")
SELECT gen_random_uuid(),
       entry.document_id,
       (row_number() OVER (PARTITION BY entry.document_id
                               ORDER BY entry.file_position, entry.ordinal) - 1)::int,
       entry.file_id,
       entry.page_index,
       entry.turn,
       entry.crop,
       entry.crop_source
FROM (
    SELECT df.document_id,
           df.position AS file_position,
           df.file_id,
           shape.ordinal,
           shape.page_index,
           -- A crop only ever meant an image, and an image is one page: it lands on the page it
           -- belonged to. Anything else kept no crop the build ever read.
           CASE WHEN f.mime_type LIKE 'image/%' AND f.mime_type <> 'image/svg+xml'
                THEN f.crop
           END AS crop,
           CASE WHEN f.mime_type LIKE 'image/%' AND f.mime_type <> 'image/svg+xml'
                THEN f.crop_source
                ELSE 'NONE'::"ValueSource"
           END AS crop_source,
           -- An image carried one turn with a mirror; a PDF carried a quarter turn per page, indexed
           -- by the page's own index — which is exactly the page each entry names. A turn of nothing
           -- is no turn.
           CASE
             WHEN f.mime_type LIKE 'image/%' AND f.mime_type <> 'image/svg+xml'
                  AND jsonb_typeof(f.rotation) = 'object'
               THEN f.rotation
             WHEN shape.page_index IS NOT NULL
                  AND jsonb_typeof(f.page_rotations) = 'array'
                  AND (f.page_rotations ->> shape.page_index) ~ '^[1-3]$'
               THEN jsonb_build_object(
                      'quarterTurns', (f.page_rotations ->> shape.page_index)::int,
                      'mirrored', false)
           END AS turn
    FROM "document_files" df
    JOIN "files" f ON f.id = df.file_id
    -- Whether the stored order is one this build could ever have obeyed: an array of whole page
    -- numbers, as many as the file was counted to hold. Anything else is no order at all, exactly as
    -- the build read it (docs/05 §5.5 step 1). Written as nested CASEs because `jsonb_array_length`
    -- raises on a scalar and a boolean AND does not promise to evaluate left to right.
    CROSS JOIN LATERAL (
        SELECT CASE WHEN jsonb_typeof(f.page_order) = 'array'
                    THEN CASE WHEN f.page_count IS NOT NULL
                               AND jsonb_array_length(f.page_order) = f.page_count
                               AND NOT EXISTS (
                                     SELECT 1 FROM jsonb_array_elements(f.page_order) AS element
                                     WHERE jsonb_typeof(element) <> 'number'
                                        OR (element #>> '{}') !~ '^[0-9]+$')
                              THEN true ELSE false END
                    ELSE false END AS use_order
    ) stored
    CROSS JOIN LATERAL (
        -- A stored order: that many entries, in that order.
        SELECT ordered.ordinality::int AS ordinal, (ordered.value)::int AS page_index
        FROM jsonb_array_elements_text(f.page_order) WITH ORDINALITY AS ordered(value, ordinality)
        WHERE stored.use_order
        UNION ALL
        -- A counted file with no order, or an order that never described it: its pages, as they lie.
        SELECT counted::int, (counted - 1)::int
        FROM generate_series(1, COALESCE(f.page_count, 0)) AS counted
        WHERE NOT stored.use_order
          AND f.page_count IS NOT NULL
          AND f.page_count > 0
        UNION ALL
        -- Nobody has counted it: one entry standing for the file whole, until a build expands it.
        SELECT 1, NULL::int
        WHERE NOT stored.use_order
          AND (f.page_count IS NULL OR f.page_count < 1)
    ) shape
) entry;
-- <<< every existing row into pages

DROP TABLE "document_files";

ALTER TABLE "files" DROP COLUMN "crop";
ALTER TABLE "files" DROP COLUMN "crop_source";
ALTER TABLE "files" DROP COLUMN "rotation";
ALTER TABLE "files" DROP COLUMN "page_order";
ALTER TABLE "files" DROP COLUMN "page_rotations";
