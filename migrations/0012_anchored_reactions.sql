-- B13 Anchored reactions (birthday.md "Anchored reactions (founder, 2026-06-12:
-- variant A — inline emoji chip)").
--
-- Reactions become a 3-way mutually-exclusive target:
--   comment_id set  -> on a comment   (existing)
--   anchor set      -> on a text span (NEW — same W3C text-quote shape as comments)
--   both null       -> on the doc     (existing)
--
-- Anchored reactions ride the SAME tier-1/2/3 re-anchoring as comments on every
-- doc write, so they carry the same operational columns: anchored_version (the
-- doc version the offsets were computed against) and orphaned (the quote no
-- longer resolves -> degrade to doc-level display, kept). A 400 is returned at
-- the API if both comment_id AND anchor are supplied (mutual exclusion).
--
-- DEDUP. The old unique key folded the 2-way target into one index:
--   (doc_id, COALESCE(comment_id,0), author_user_id, emoji)
-- That can't distinguish two different anchored reactions by the same author
-- with the same emoji on two different spans (both have comment_id NULL). We
-- extend the key with a NORMALIZED ANCHOR SIGNATURE so unique(doc, author, emoji,
-- target) still holds across all three target kinds and the re-click toggle keeps
-- working. The signature is the same prefix|exact|suffix triple the overlay/
-- shared.js uses to group reactions (anchorSig), kept in a generated column so the
-- DB enforces it — '' for non-anchored reactions (doc-level / comment-level),
-- where COALESCE(comment_id,0) already disambiguates.

ALTER TABLE reactions
  ADD COLUMN IF NOT EXISTS anchor           jsonb,
  ADD COLUMN IF NOT EXISTS anchored_version int,
  ADD COLUMN IF NOT EXISTS orphaned         boolean NOT NULL DEFAULT false;

-- Normalized anchor signature, generated from the anchor jsonb. Mirrors the
-- client's anchorSig = (prefix||"")+"|"+exact+"|"+(suffix||""). Reactions with no
-- anchor get '' (empty) so they collide with each other only when the
-- (doc, comment_id, author, emoji) tuple matches — i.e. the prior semantics.
ALTER TABLE reactions
  ADD COLUMN IF NOT EXISTS anchor_sig text
    GENERATED ALWAYS AS (
      CASE
        WHEN anchor IS NULL THEN ''
        ELSE COALESCE(anchor->>'prefix','') || '|' ||
             COALESCE(anchor->>'exact','')  || '|' ||
             COALESCE(anchor->>'suffix','')
      END
    ) STORED;

-- Replace the 2-way unique index with the 3-way one (now keyed on the anchor
-- signature too). Drop the old one first; the generated column makes the new key
-- deterministic and DB-enforced.
DROP INDEX IF EXISTS reactions_unique_target;
CREATE UNIQUE INDEX reactions_unique_target
  ON reactions (doc_id, COALESCE(comment_id, 0), anchor_sig, author_user_id, emoji);

-- Anchored reactions are fetched + re-anchored per doc; an index on the anchored
-- subset keeps the all-threads read + the re-anchor sweep tight.
CREATE INDEX IF NOT EXISTS reactions_anchored_idx
  ON reactions (doc_id) WHERE anchor IS NOT NULL;
