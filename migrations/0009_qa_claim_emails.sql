-- QA escape hatch for the B9 hybrid claim email. REMOVABLE post-launch.
--
-- When QA_SECRET is set, /agent/identity (claim_delivery=email) stores the
-- plaintext claim-email contents here at send time — the 6-digit code and the
-- approve link — so automated reviewers (mailbox raf+qa-*@kernel.sh) can
-- complete the email-mode flow programmatically via
-- GET /internal/qa/latest-claim-email?email=... guarded by the X-QA-Secret
-- header. This table is ONLY written when QA mode is enabled; with QA_SECRET
-- unset, nothing is written and the endpoint 404s. The code is stored hashed
-- everywhere else (claim_codes.code_hash) — this plaintext mirror exists solely
-- for QA, exactly like qa_login_links (0006).
--
-- To remove post-launch: unset QA_SECRET (disables writes + endpoint), then
-- drop this table and delete app/internal/qa/.
CREATE TABLE qa_claim_emails (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email           citext      NOT NULL,
  code            text        NOT NULL,   -- plaintext 6-digit user_code (QA only)
  approve_link    text        NOT NULL,   -- plaintext approve URL (QA only)
  claim_code_id   bigint      REFERENCES claim_codes(id),
  consumed_at     timestamptz,            -- mirrors claim_codes consumption (informational)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qa_claim_emails_email_idx ON qa_claim_emails (email, created_at DESC);
