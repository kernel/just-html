-- Drop the QA escape-hatch tables. The QA backdoor (the /internal/qa endpoints,
-- the QA_SECRET-guarded write blocks, and QA_SECRET itself) has been removed
-- from the app; end-to-end testing now runs entirely through real AgentMail
-- inboxes (scripts/e2e.ts), with no app-side test secret. These plaintext
-- mirror tables (qa_login_links from 0006, qa_claim_emails from 0009) are no
-- longer written to and can be dropped.
DROP TABLE IF EXISTS qa_login_links;
DROP TABLE IF EXISTS qa_claim_emails;
