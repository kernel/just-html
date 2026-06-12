-- QA escape hatch (B2). REMOVABLE post-launch.
--
-- When QA_SECRET is set in the environment, /login stores the plaintext
-- magic-link URL here at send time so automated reviewers (whose mailbox is
-- raf+qa-*@kernel.sh) can complete the flow programmatically via
-- GET /internal/qa/latest-login-link?email=... guarded by the X-QA-Secret
-- header. This table is ONLY written when QA mode is enabled; with QA_SECRET
-- unset, nothing is ever written here and the endpoint 404s.
--
-- To remove post-launch: unset QA_SECRET (disables writes + endpoint), then
-- drop this table and delete app/internal/qa/.
CREATE TABLE qa_login_links (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       citext      NOT NULL,
  link        text        NOT NULL,   -- plaintext magic-link URL (QA only)
  consumed_at timestamptz,            -- mirrors login_tokens consumption
  login_token_id bigint   REFERENCES login_tokens(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qa_login_links_email_idx ON qa_login_links (email, created_at DESC);
