-- B12 One auth flow (founder directive 2026-06-12, birthday.md "The claim
-- ceremony — ONE flow").
--
-- The claim ceremony is simplified to exactly one flow: registration emails the
-- human a 6-digit code (the code and nothing else), the human reads it back to
-- the agent, and the agent submits it to POST /agent/identity/claim/complete.
-- Removed: the approve link, the hosted /claim form, the spec-pure variant, and
-- the claim_delivery parameter.
--
-- This migration is non-destructive. Per the directive, columns that are now
-- dead are LEFT IN PLACE and marked unused rather than dropped (a destructive
-- column drop buys nothing here and risks the prod table). The only functional
-- change is relaxing the qa_claim_emails.approve_link NOT NULL constraint, since
-- the claim email no longer carries an approve link to mirror for QA.

-- qa_claim_emails: the claim email is now code-only; stop requiring approve_link.
ALTER TABLE qa_claim_emails ALTER COLUMN approve_link DROP NOT NULL;

-- claim_codes: new attempts no longer carry a hosted-form attempt token (cvt_)
-- or its TTL window, so relax those NOT NULL constraints. The UNIQUE index on
-- view_token_hash stays (Postgres permits multiple NULLs under a UNIQUE index).
ALTER TABLE claim_codes ALTER COLUMN view_token_hash DROP NOT NULL;
ALTER TABLE claim_codes ALTER COLUMN view_expires_at DROP NOT NULL;

-- Dead columns retained for non-destructiveness (no code reads or writes them
-- after B12). Documented here as the record that they are intentionally unused:
--   agent_registrations.claim_delivery   -- was 'email'|'agent' (one flow now)
--   claim_codes.view_token_hash          -- was cvt_ for the hosted /claim form
--   claim_codes.view_expires_at          -- was the cvt_/approve-link TTL window
--   claim_codes.approve_token_hash       -- was cva_ for the emailed approve link
--   claim_codes.approved_at              -- was set when the approve link fired
-- (claim_codes.claim_email_sent_at remains in use — set when claim_email.sent
-- fires.) New claim_codes rows insert NULL into the dead hash columns.
COMMENT ON COLUMN agent_registrations.claim_delivery IS 'UNUSED since B12 (one claim flow); always emails the code';
COMMENT ON COLUMN claim_codes.view_token_hash IS 'UNUSED since B12 (hosted /claim form removed)';
COMMENT ON COLUMN claim_codes.approve_token_hash IS 'UNUSED since B12 (approve link removed)';
COMMENT ON COLUMN claim_codes.approved_at IS 'UNUSED since B12 (approve link removed)';
