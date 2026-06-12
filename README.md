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
npx vercel --prod --token "$VERCEL_TOKEN" --scope "$VERCEL_ORG_ID"
```

Production deployment serves at the project's `*.vercel.app` URL and (once the
apex domain is verified — see below) at https://justhtml.sh.

## Domain verification (one outstanding human action)

The `justhtml.sh` apex is attached to the Vercel project but **not yet
verified**, so no TLS cert is issued and the apex does not serve. This is the
only thing standing between B1 and a green `https://justhtml.sh/api/health`.

The DNS zone for `justhtml.sh` lives on Vercel's nameservers
(`ns1/ns2.vercel-dns.com`) but in a **different Vercel account** than the one
our `VERCEL_TOKEN` can reach (team `raf-kernelsh-stripe`). Every DNS-record API
path 403s with our token, so the record cannot be added from this repo's
credentials — it requires a human in the account that owns the domain.

**Required action** (in the Vercel account that owns `justhtml.sh`), either:

1. Add this DNS record:

   ```
   TXT  _vercel.justhtml.sh  =  vc-domain-verify=justhtml.sh,d53ae829a19aa70c4282
   ```

   Vercel then verifies and issues the cert automatically — **no redeploy
   needed**. (If the verify token has rotated, run `scripts/verify-domain.sh`
   step 1, or check the Vercel project's Domains tab, for the current value.)

2. **Or** transfer the domain into team `raf-kernelsh-stripe`, after which our
   token can manage it directly.

Once the record lands, confirm everything from this repo:

```sh
./scripts/verify-domain.sh
```

That re-asks Vercel to verify, shows the verification state, checks DNS, and
probes `https://justhtml.sh/api/health`. B1 is done when it prints
`{"ok":true,"db":true}`.
