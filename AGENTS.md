<!-- stripe-projects-cli managed:agents-md:start -->
## Stripe Projects CLI

This repository is initialized for the Stripe project "2026-06-11-justhtml".

## Tools used

- [Stripe CLI](https://docs.stripe.com/stripe-cli) with the `projects` plugin to manage third-party services, credentials, and deployments for this project. Use the stripe-projects-cli to manage deploying and access to third party services.
<!-- stripe-projects-cli managed:agents-md:end -->

## Infrastructure (authoritative as of 2026-06-12)

- **Database**: PlanetScale Postgres, managed via Stripe Projects (resource
  `justhtml-db`). Credentials in `.env` (`PLANETSCALE_*`).
- **Hosting**: Vercel project `justhtml` in the **kernel team** (`onkernel`,
  `team_Uu9t3uNi9jk9ySkscUsrqrvv`) — NOT managed by Stripe Projects.
  **AUTO-DEPLOY IS ON (2026-06-13):** the project is linked to GitHub
  `kernel/just-html`, production branch `main` — every push to `main`
  auto-deploys to production, and branches/PRs get preview URLs. So a normal
  `git push` ships to prod; you usually do NOT need a manual deploy. Only
  push commits you intend to go live. Manual deploy is still available if
  needed: `npx vercel deploy --prod --yes --token "$VERCEL_TOKEN" --scope onkernel`.
  `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` in `.env` are
  maintained by hand; `stripe projects env --pull` does NOT manage them.
  The domain justhtml.sh is owned by the same team (attached + verified).
- **Email**: Resend, manual account (not Stripe Projects), sending domain
  `notify.justhtml.sh`, `RESEND_API_KEY` in `.env` (also hand-maintained).
- A defunct Stripe-provisioned Vercel plan (`vercel-plan`, free hobby) exists
  in the Stripe project but is detached from all environments and unused —
  plan resources can't be deleted via the CLI. Ignore it.
