ALTER TABLE receipts
  ADD COLUMN review_state VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN review_id UUID REFERENCES receipt_reviews(id);

ALTER TABLE receipts ADD CONSTRAINT receipts_review_state_check CHECK (
  (review_state = 'ACTIVE' AND review_id IS NULL)
  OR (review_state IN ('REPLACED', 'MERGE_UNDONE') AND review_id IS NOT NULL)
);
CREATE INDEX receipts_review_id_idx ON receipts(review_id);

-- >>> Restore only rows hidden by a recorded duplicate decision. Missing/converted profiles and
-- unrelated deletions remain untouched. An active replacement takes precedence over old undone
-- merges of the same reusable PDF. Existing active rows need no change.
WITH dispositions AS (
  SELECT r.id, decision.id AS review_id, decision.state
  FROM receipts r
  JOIN archive_items a ON a.id = r.id AND a.kind = 'RECEIPT' AND a.deleted_at IS NOT NULL
  JOIN LATERAL (
    SELECT h.id, 'REPLACED'::text AS state, 0 AS priority, h.position
    FROM receipt_reviews h
    WHERE h.owner_id = a.created_by_id AND h.undone_at IS NULL AND (
      (h.action = 'KEEP_FIRST' AND h.second_id = r.id)
      OR (h.action = 'KEEP_SECOND' AND h.first_id = r.id)
      OR (h.action = 'MERGE' AND r.id IN (h.first_id, h.second_id))
    )
    UNION ALL
    SELECT h.id, 'MERGE_UNDONE'::text AS state, 1 AS priority, h.position
    FROM receipt_reviews h
    WHERE h.owner_id = a.created_by_id AND h.action = 'MERGE'
      AND h.undone_at IS NOT NULL AND h.result_id = r.id
    ORDER BY priority, position DESC LIMIT 1
  ) decision ON TRUE
), preserved AS (
  UPDATE receipts r SET review_state = d.state, review_id = d.review_id
  FROM dispositions d WHERE r.id = d.id RETURNING r.id
)
UPDATE archive_items a SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
FROM preserved p WHERE a.id = p.id;
-- <<<
