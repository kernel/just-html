-- Phase-2 collaboration tables (comments, reactions). Designed now per
-- birthday.md "Data model" + "Comment anchoring"; endpoints built in phase 2.

-- comments — 1-level threads, W3C text-quote anchors (null = doc-level).
CREATE TABLE comments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id           bigint NOT NULL REFERENCES documents(id),
  author_user_id   bigint REFERENCES users(id),
  parent_id        bigint REFERENCES comments(id),     -- 1-level threads
  anchor           jsonb,                               -- text-quote selector; null = doc-level
  anchored_version int,                                 -- doc version anchor computed against
  orphaned         boolean NOT NULL DEFAULT false,      -- anchor no longer resolves
  body             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  deleted_at       timestamptz
);
CREATE INDEX comments_doc_idx ON comments (doc_id);
CREATE INDEX comments_parent_idx ON comments (parent_id);

-- reactions — emoji on a doc or a comment; one per (target, author, emoji).
CREATE TABLE reactions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id         bigint NOT NULL REFERENCES documents(id),
  comment_id     bigint REFERENCES comments(id),        -- null = on the doc
  author_user_id bigint REFERENCES users(id),
  emoji          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- Uniqueness across (doc, comment-or-doc-level, author, emoji). comment_id NULL
-- means doc-level; COALESCE folds the two-target shape into one unique index.
CREATE UNIQUE INDEX reactions_unique_target
  ON reactions (doc_id, COALESCE(comment_id, 0), author_user_id, emoji);
