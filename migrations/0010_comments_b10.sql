-- B10 Comments — operational columns on top of the phase-2 schema (0004).
--
-- 0004 landed the comments + reactions tables at design time. Building the
-- endpoints (birthday.md "Comments & reactions API") needs two small additions:
--   - comments.edited_at: set when an author edits their own body (PATCH body),
--     so the UI/API can show "(edited)" without inferring it from updated_at.
--   - comments.resolved_by_user_id / resolved is already modeled via resolved_at
--     (timestamp == resolved). We add resolved_by_user_id for attribution
--     (resolve/unresolve is "anyone who can comment", so who resolved matters).
--   - reactions: an index on comment_id for the per-comment reaction fan-in used
--     by GET /comments (the all-threads view attaches reactions per target).
--
-- The anchor/anchored_version/orphaned columns (re-anchoring) already exist.

ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS edited_at            timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by_user_id  bigint REFERENCES users(id);

-- Reactions are fetched per-comment (and doc-level) in the all-threads view.
CREATE INDEX IF NOT EXISTS reactions_comment_idx ON reactions (comment_id);
CREATE INDEX IF NOT EXISTS reactions_doc_idx     ON reactions (doc_id);

-- Live (non-deleted) comments per doc are counted against the 1,000/doc cap and
-- listed in document order; a partial index keeps that hot path tight.
CREATE INDEX IF NOT EXISTS comments_doc_live_idx
  ON comments (doc_id) WHERE deleted_at IS NULL;
