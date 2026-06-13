# Development

Engineering, operations, and surface reference for justhtml.sh. For what it is
and how to use it, see the [README](README.md); for live agent-facing usage,
[`/llms.txt`](https://justhtml.sh/llms.txt).

## Architecture

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
tokens, sessions, api keys), documents + versions, collaboration tables
(comments with W3C text-quote anchors + re-anchoring, reactions), rate-limit +
audit tables, and the removable `qa_login_links` table.

## The agent skill

`/llms.txt` is also published as an installable agent skill
(`npx skills add kernel/just-html`). Both are generated from one source —
[`lib/skill-content.ts`](lib/skill-content.ts) — so they never drift:

- `app/llms.txt/route.ts` serves `LLMS_BODY` from it.
- `npm run gen:skill` (runs `scripts/gen-skill.ts` via `tsx`) writes
  `skills/just-html/SKILL.md` = frontmatter + `LLMS_BODY`.
- The `skill-sync` GitHub Action regenerates and commits `SKILL.md` whenever the
  content changes, so the committed skill is always in sync.

Edit the content in `lib/skill-content.ts`, never the generated files.

## Deploy

Production deploys come from the **Vercel ↔ GitHub** integration: every push to
`main` auto-deploys to production (branches/PRs get preview URLs). A manual
deploy is still available:

```sh
npx vercel deploy --prod --yes --token "$VERCEL_TOKEN" --scope onkernel
```

The `justhtml.sh` apex is attached + verified on the kernel-team Vercel project
and serves production. Verify after deploy: `GET https://justhtml.sh/api/health`
returns `{"ok":true,"db":true}`.

## Surfaces

Agent / discovery (plain text or JSON, zero JS):

- `GET /` — homepage / man-page docs (NAME … SEE ALSO + a copy-pasteable agent prompt).
- `GET /auth.md` — prose auth protocol.
- `GET /llms.txt` — terse agent usage: every endpoint with a curl example + limits.
- `GET /api/spec.yaml` — OpenAPI 3.1 (validated with `@redocly/cli`).
- `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-authorization-server`.

Auth:

- Agent claim ceremony — **one flow** (no approve link, no hosted form, no
  `claim_delivery` parameter): `POST /agent/identity` emails the human a 6-digit
  code; the human reads it back to the agent; `POST /agent/identity/claim/complete`
  confirms it; `POST /oauth2/token` (claim grant) issues the key once.
  `POST /agent/identity/claim` re-mints a fresh code; `POST /oauth2/revoke`
  revokes. The ceremony never mints a browser session.
- Human (plain-HTML forms): `/login`, `/login/verify` (magic-link sign-in — the
  only human sign-in; unrelated to the claim ceremony). The verify page is
  scanner-safe (GET confirms, POST consumes).
- API 401s carry `WWW-Authenticate: Bearer resource_metadata="…"`.

Documents (`/api/v1`, `Authorization: Bearer jh_live_…`): `docs` CRUD,
`/edits` (deterministic patches), `/rotate-token`, `/versions`, `/grants`.
`GET /api/v1/docs` items carry `access` and `comment_count`. Creating an
**email** grant sends the grantee a share-notification email — one single-use,
7-day login link (`kind='share'` on `login_tokens`) with `next=/d/:slug` that
signs them in (email-keyed session, no account) and lands them on the doc.
`notify:false` suppresses it; **domain grants never notify**.

Comments & reactions (`/api/v1/docs/:slug/comments`, `/reactions`): humans and
agents use the same endpoints. A human click-drags to highlight; an agent
"highlights" by quoting (W3C text-quote anchor `{exact, prefix?, suffix?}`;
null = doc-level). `GET /comments` returns the complete all-threads view
(anchored in document order → doc-level → orphaned, resolved behind a flag) plus
each thread's reactions, any `doc_reactions`, and span reactions as
`anchored_reactions` (grouped by anchor signature, in document order). Anchors —
on comments AND anchored reactions — re-anchor in the same transaction as every
doc write (offset-map through patches → quote re-find → orphan; an orphaned
anchored reaction degrades to doc-level display). Reactions are
**attributed-only** (a curated emoji set; unique per target+author+emoji; re-posting
toggles off) and target one of three things: a comment (`comment_id`), a text
span (`anchor` — same W3C shape as a comment anchor), or the whole doc (neither;
supplying both `comment_id` and `anchor` is a 400). In the viewer a reacted span
gets the same yellow highlight as a comment plus an inline emoji+count chip at the
span's end (chip hover → reactor gravatars/emails; click your own → toggle off);
the chip/highlight appear optimistically the instant you react, no reload. Comment:
owner / editor or commenter grant / view-token holder with identity / any identity
on a public doc. React: anyone who can view, with identity. Anonymous never writes.

Viewing: `/d/:slug` (shell + sandboxed iframe; the google-docs-style comment
rail appears once a doc has comments/reactions or the viewer can interact —
zero comments + non-interacting viewer = zero chrome), `/d/:slug/raw`
(CSP-sandboxed, origin-less; `?overlay=1` injects the highlight/selection
overlay only inside the shell's iframe — direct `/raw` stays byte-pristine),
`/d/:slug/history` (diff view). A private doc
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
