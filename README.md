# justhtml.sh

An agent-first minimal HTML document host. Single Next.js (App Router) app,
route-handler-first, plain-HTML man-page style. Plan of record:
[`docs/birthday.md`](docs/birthday.md). Auth spec:
[`docs/authmd-implementation.md`](docs/authmd-implementation.md).

## Local development

```sh
npm install
npm run dev          # http://localhost:3000
npm run migrate      # apply SQL migrations (reads .env)
npm run migrate:status
```

## Health

`GET /api/health` returns `{"ok":true,"db":true}` and actually checks Postgres
connectivity.

## Deploy

```sh
npx vercel deploy --prod --yes --token "$VERCEL_TOKEN" --scope onkernel
```

The `justhtml.sh` apex is attached + verified on the kernel-team Vercel project
and serves production. `GET https://justhtml.sh/api/health` returns
`{"ok":true,"db":true}`.

## Auth (B2)

The full auth.md `service_auth` flow is live. See
[`docs/authmd-implementation.md`](docs/authmd-implementation.md) for the
authoritative spec. Surfaces:

- Agent: `POST /agent/identity`, `POST /agent/identity/claim` (re-mint),
  `POST /oauth2/token` (claim grant), `POST /oauth2/revoke`.
- Discovery: `/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-authorization-server`, `/auth.md`.
- Human (plain-HTML forms, zero JS): `/login`, `/login/verify`, `/claim`.
- API 401s carry `WWW-Authenticate: Bearer resource_metadata="…"`.

Operator script — revoke every live key for a user (incident response):

```sh
# UPDATE api_keys SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL;
```

### QA escape hatch (REMOVABLE post-launch)

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
2. Delete `app/internal/qa/` and the QA write block in `app/login/route.ts` /
   `app/login/verify/route.ts`.
3. `DROP TABLE qa_login_links;`
