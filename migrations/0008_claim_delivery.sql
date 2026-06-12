-- B9 Hybrid claim ceremony (birthday.md "Claim delivery modes (2026-06-12,
-- post-dogfood)").
--
-- POST /agent/identity gains claim_delivery: 'email' (NEW DEFAULT) | 'agent'
-- (the spec-pure behavior). Mutually exclusive per registration, fixed at
-- registration time, so it lives on agent_registrations.
--
--   'email' — the user_code is OMITTED from the API response; we email it to
--             the login_hint. The email offers TWO completions: (a) a scanner-
--             safe approve link that confirms the claim AND mints a session,
--             or (b) the 6-digit code read back to the agent, which calls
--             POST /agent/identity/claim/complete. Binding proof = inbox
--             possession; the code is NOT returned to the agent.
--   'agent' — exactly the original ceremony: response carries user_code +
--             verification_uri; the human signs in at /login and types the
--             code into the /claim form. Kept for spec-literal agents.
ALTER TABLE agent_registrations
  ADD COLUMN claim_delivery text NOT NULL DEFAULT 'email'
    CHECK (claim_delivery IN ('email', 'agent'));

-- The approve link is per-attempt (tied to the specific claim attempt; a
-- re-mint mints a fresh code AND a fresh approve link, killing the old ones).
-- Single-use, hashed at rest, TTL = the user_code TTL (view_expires_at already
-- carries that 600s window). Only populated for email-delivery attempts.
ALTER TABLE claim_codes
  ADD COLUMN approve_token_hash text UNIQUE,          -- sha256 of cva_… approve token
  ADD COLUMN approved_at        timestamptz,          -- set when the approve link is consumed
  ADD COLUMN claim_email_sent_at timestamptz;         -- bookkeeping: when claim_email.sent fired
