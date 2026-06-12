# justhtml.sh

An agent-first minimal HTML document host. An agent self-onboards (via the
[auth.md](https://workos.com/auth-md) `service_auth` flow), gets a long-lived
API key, and publishes HTML documents to stable URLs like
`https://justhtml.sh/d/fierce-tiger-12345`. Docs are private by default,
shareable via a view token, and optionally public. Humans and their agents
collaborate on the same documents.

Single Next.js (App Router) app on Vercel. **Route-handler-first**: every
surface that can be plain HTML/text/JSON IS, served with `new Response(...)` —
man-page style, zero React, zero JS. React runs in exactly two places: the
`/d/:slug` viewer shell and `/d/:slug/history`. Storage is PlanetScale Postgres
only (docs are `TEXT`, capped at 2 MB). No Go backend, no Redis.

Plan of record: [`docs/birthday.md`](docs/birthday.md). Auth spec:
[`docs/authmd-implementation.md`](docs/authmd-implementation.md).

## Local development

```sh
npm install
cp .env.example .env   # then fill in the values (see below)
npm run dev            # http://localhost:3000
```

## Environment variables

All live in `.env` (never committed). See `.env.example` for the full list.

| Var                  | Purpose                                                  |
|----------------------|----------------------------------------------------------|
| `PLANETSCALE_URL`    | Postgres connection string (psql-compatible wire)        |
| `RESEND_API_KEY`     | Resend key for login magic-link email (`notify.justhtml.sh`) |
| `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` | Deploy pipeline   |
| `QA_SECRET`          | Optional, removable QA escape hatch (see below)          |

New env vars must be set in **both** `.env` and Vercel production env.

## Migrations

SQL migrations live in `migrations/` (numbered, run in order). They run directly
against the production PlanetScale database — there is no separate dev DB.

```sh
npm run migrate          # apply pending migrations (reads .env)
npm run migrate:status   # show applied / pending
```

Current schema: extensions, auth (users, registrations, claim codes, login
tokens, sessions, api keys), documents + versions, phase-2 collab tables
(comments/reactions, designed-not-wired), rate-limit + audit tables, and the
removable `qa_login_links` table.

## Deploy

```sh
npx vercel deploy --prod --yes --token "$VERCEL_TOKEN" --scope onkernel
```

The `justhtml.sh` apex is attached + verified on the kernel-team Vercel project
and serves production. Verify after deploy: `GET https://justhtml.sh/api/health`
returns `{"ok":true,"db":true}`.

## Surfaces

Agent / discovery (plain text or JSON, zero JS):

- `GET /` — homepage / man-page docs (NAME … LIMITS + a copy-pasteable agent prompt).
- `GET /auth.md` — prose auth protocol.
- `GET /llms.txt` — terse agent usage: every endpoint with a curl example + limits.
- `GET /api/spec.yaml` — OpenAPI 3.1 (validated with `@redocly/cli`).
- `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-authorization-server`.

Auth:

- Agent: `POST /agent/identity`, `POST /agent/identity/claim` (re-mint),
  `POST /oauth2/token` (claim grant), `POST /oauth2/revoke`.
- Human (plain-HTML forms): `/login`, `/login/verify`, `/claim`.
- API 401s carry `WWW-Authenticate: Bearer resource_metadata="…"`.

Documents (`/api/v1`, `Authorization: Bearer jh_live_…`): `docs` CRUD,
`/edits` (deterministic patches), `/rotate-token`, `/versions`, `/grants`.
Creating an **email** grant sends the grantee a share-notification email — one
single-use, 7-day login link (`kind='share'` on `login_tokens`) with
`next=/d/:slug` that signs them in (email-keyed session, no account) and lands
them on the doc. `notify:false` suppresses it; **domain grants never notify**.

Viewing: `/d/:slug` (shell + sandboxed iframe), `/d/:slug/raw`
(CSP-sandboxed, origin-less), `/d/:slug/history` (diff view). A private doc
authorizes in order: owner session → email-grant session → domain-grant
session → view token → public. The private-doc notice always offers "Was this
shared with you? Sign in" (`/login?next=/d/:slug`) so an expired share link
degrades to one extra email round-trip, never a dead end.

## Operator: bulk-revoke a user's keys (incident response)

```sql
UPDATE api_keys SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL;
```

## QA escape hatch (REMOVABLE post-launch)

To let automated reviewers complete the magic-link flow without reading a real
inbox, `GET /internal/qa/latest-login-link?email=…` (header
`X-QA-Secret: $QA_SECRET`) returns the most recent **unconsumed** login link
plaintext for an email. The plaintext is stored in the `qa_login_links` table
**only when `QA_SECRET` is set** — with it unset, nothing is ever written there
and the endpoint 404s. `QA_SECRET` is a strong random value set in both `.env`
and Vercel production env.

**To remove before public launch:**

1. Unset `QA_SECRET` in `.env` and Vercel prod (this alone disables both the
   writes and the endpoint).
2. Delete `app/internal/qa/` and the QA write blocks in `app/login/route.ts` /
   `app/login/verify/route.ts`.
3. `DROP TABLE qa_login_links;`
