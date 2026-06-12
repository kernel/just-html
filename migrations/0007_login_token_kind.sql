-- B7 Share notifications (birthday.md "Share notifications: the non-user
-- grantee story (v1)").
--
-- Login tokens gain a `kind` distinguishing the two magic-link flavors:
--   'login' — the plain /login magic link, 15-minute TTL (default; existing rows).
--   'share' — the link embedded in a share-notification email, 7-day TTL.
-- Both mint an email-keyed session on click; only the TTL and the entry point
-- differ. Same security anchor either way: possession of the inbox.
ALTER TABLE login_tokens
  ADD COLUMN kind text NOT NULL DEFAULT 'login'
    CHECK (kind IN ('login', 'share'));
