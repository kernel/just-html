-- B13 fixup: anchor_sig as a PLAIN application-populated column.
--
-- 0012 declared anchor_sig as GENERATED ALWAYS AS (...) STORED. PlanetScale's
-- Postgres engine did NOT preserve the generation expression (it rewrote the DDL
-- into a CHECK that anchor_sig IS NULL iff anchor IS NULL and left the column
-- unpopulated). Rather than depend on generated columns we don't control, make
-- anchor_sig a normal NOT NULL column defaulting to '' and have the application
-- compute the signature on insert (lib/docs/reactions.ts: anchorSignature). The
-- unique index over it (from 0012) is unchanged and keeps enforcing
-- unique(doc, comment-or-doc-or-anchor target, author, emoji).
--
-- Signature contract (must match lib/docs/reactions.ts + the overlay's anchorSig):
--   anchored:     prefix + '|' + exact + '|' + suffix   (decoded text-quote)
--   non-anchored: ''                                     (doc/comment level)

-- Drop the index that depends on the column, the stray CHECK constraints the
-- engine synthesized, and the column itself; then recreate cleanly.
DROP INDEX IF EXISTS reactions_unique_target;
ALTER TABLE reactions DROP CONSTRAINT IF EXISTS reactions_anchor_sig_consistent;
ALTER TABLE reactions DROP COLUMN IF EXISTS anchor_sig;

ALTER TABLE reactions
  ADD COLUMN anchor_sig text NOT NULL DEFAULT '';

-- Re-create the 3-way unique target index.
CREATE UNIQUE INDEX reactions_unique_target
  ON reactions (doc_id, COALESCE(comment_id, 0), anchor_sig, author_user_id, emoji);
