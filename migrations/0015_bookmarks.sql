-- Bookmarks: per-email saved docs for the web UI.
CREATE TABLE bookmarks (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bookmarker_email  citext NOT NULL,
  doc_id            bigint NOT NULL REFERENCES documents(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bookmarker_email, doc_id)
);
CREATE INDEX bookmarks_bookmarker_idx ON bookmarks (bookmarker_email);
