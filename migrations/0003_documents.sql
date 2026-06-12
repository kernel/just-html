-- Documents domain (B3): documents, doc_versions, doc_grants.
-- Per birthday.md "Data model". Built later, schema landed now.

-- documents — current content + metadata. html is TOASTed TEXT (≤2 MB cap
-- enforced in app). Soft-delete via deleted_at.
CREATE TABLE documents (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text NOT NULL UNIQUE,                   -- 'fierce-tiger-12345' (not a secret)
  owner_id    bigint NOT NULL REFERENCES users(id),
  title       text,
  html        text NOT NULL DEFAULT '',               -- current content
  version     int NOT NULL DEFAULT 1,
  is_public   boolean NOT NULL DEFAULT false,
  view_token  text NOT NULL,                          -- 'k7Pq2xWmRb' (rotatable; the un-share story)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX documents_owner_idx ON documents (owner_id);

-- doc_versions — full snapshot per write; powers history + diff + re-anchoring.
CREATE TABLE doc_versions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id         bigint NOT NULL REFERENCES documents(id),
  version        int NOT NULL,
  html           text NOT NULL,                        -- full snapshot
  author_user_id bigint REFERENCES users(id),
  edit_kind      text NOT NULL CHECK (edit_kind IN ('create', 'patch', 'rewrite')),
  patch          jsonb,                                -- edits payload when edit_kind='patch'
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, version)
);

-- doc_grants — email- or domain-targeted sharing (v1; editor role launch req).
CREATE TABLE doc_grants (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id       bigint NOT NULL REFERENCES documents(id),
  grantee_type text NOT NULL CHECK (grantee_type IN ('email', 'domain')),
  grantee      citext NOT NULL,                        -- 'teammate@co.com' or 'co.com'
  role         text NOT NULL CHECK (role IN ('editor', 'commenter', 'viewer')),
  created_by   bigint REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, grantee_type, grantee)
);
CREATE INDEX doc_grants_doc_idx ON doc_grants (doc_id);
