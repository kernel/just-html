-- Bookmarks: per-email saved docs for the web UI. view_token is the token the
-- doc was reachable through when bookmarked (NULL when access was via
-- ownership, a grant, or public); the bookmarks page re-checks access with it,
-- so a token-shared doc stays reachable until the token is rotated or revoked.
CREATE TABLE bookmarks (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bookmarker_email  citext NOT NULL,
  doc_id            bigint NOT NULL REFERENCES documents(id),
  view_token        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bookmarker_email, doc_id)
);
CREATE INDEX bookmarks_bookmarker_idx ON bookmarks (bookmarker_email);
