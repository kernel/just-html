# justhtml.sh — birthday plan

The world's most minimal collaborative HTML viewer.

## Why

HTML is back. Agents are capable of producing very high quality HTML for specs,
docs, outlines, and proposals. Today the easy path is "agent writes an HTML
file, opens a Cloudflare tunnel" — which works but is ephemeral and
non-collaborative.

justhtml.sh is a site you point your agent at. The agent self-onboards (creates
an account via the auth.md protocol), gets an API key, and publishes HTML
documents to stable URLs. Docs are private by default, shareable, and
optionally public. The humans (and their agents) you share with can view,
comment, or edit depending on the permissions you grant — it is HTML that
humans and their agents collectively edit and collaborate on (plus,
eventually, Google-Docs-style comments and reactions — nothing more).

COPY NOTE for user-facing surfaces (homepage, llms.txt): "view token" is
internal jargon — say docs are "shareable" and lead with the
humans-and-their-agents collaboration framing above. The token mechanics
belong in API docs, not marketing copy.

## Product shape

- Agent-first: the entire onboarding and publishing flow is doable by an agent
  with zero human steps except reading a one-time code from an email.
- Stable URLs: `justhtml.sh/d/fierce-tiger-12345` (heroku-style slugs).
- Private by default: private docs require `?viewtoken=k7Pq2xWmRb` (short,
  random-enough, not ugly).
- Public as an option.
- Phase 2: commenting + emoji reactions. No editing-by-others, no presence,
  no cursors. Lightly collaborative.

## Architecture

**Single Next.js app (App Router) on Vercel. No Go backend. Not even a monorepo.**

Every operation is short CRUD: auth handshake, store HTML, fetch HTML, post a
comment. Nothing long-lived, streaming, or CPU-bound. A Go backend would add a
second deploy target and CORS surface for zero benefit. If commenting ever goes
realtime, add Ably/PartyKit at that point — not a server now.

**Storage: PlanetScale Postgres ($5/mo plan) only. No object storage.**

Docs are text. Postgres `TEXT` (TOASTed) is comfortable into the megabytes.
Cap uploads at ~2 MB of HTML. Object storage only becomes interesting if we
later allow binary assets; the schema doesn't preclude swapping the `html`
column for a pointer.

**Dependencies**

| Concern   | Choice                | Provisioning (decided 2026-06-12)      |
|-----------|-----------------------|----------------------------------------|
| Hosting   | Vercel                | ✅ **DONE** (2026-06-12) — project `justhtml` in the kernel team (`onkernel`), created directly (NOT via Stripe Projects; an earlier Stripe-provisioned project in a separate team was deleted). Token-based CLI deploys; see AGENTS.md. |
| Database  | PlanetScale Postgres  | Stripe Projects: `PlanetScale / postgresql`, PS-5 cluster — $5/node/mo, 10 GB included |
| Email     | Resend                | ✅ **DONE** (2026-06-12) — manual signup (not in Stripe Projects catalog); sending domain `notify.justhtml.sh` verified, key in `.env`. Free tier covers login-link volume. |
| Domain    | justhtml.sh           | ✅ **DONE** — purchased in Kernel's Vercel account (2026-06-12) |

Code-level dependencies (npm, nothing to provision): `@pierre/diffs`,
vendored pi edit-diff logic. The auth.md protocol is implemented by us — no
WorkOS service dependency. No Stripe-payments dependency in v1 (no billing).

## Data model (Postgres)

```
users               id, email (citext, unique), created_at

agent_registrations id, type ('service_auth' only — no anonymous-start),
                    email (citext — the login_hint; user row is NOT created
                    until claim confirm, avoiding typo'd-email rows),
                    user_id (null until claimed),
                    claim_token_hash, claim_expires_at,
                    credential_issued_at (long-lived key issued exactly once
                    per registration), created_at, claimed_at
                    -- status is DERIVED from claimed_at/claim_expires_at,
                    -- not a column (no sweeper jobs; per reference impl)

claim_codes         id, registration_id,
                    code_hash (6-digit user_code, SHA-256),
                    expires_at (10 min), attempts (max 5), consumed_at
                    -- the code the agent shows the user; entered at the
                    -- hosted claim form (spec-pure ceremony)

login_tokens        id, email (citext), token_hash,
                    expires_at (15 min), consumed_at
                    -- single-use magic links for human sign-in

sessions            id, email (citext),
                    user_id (nullable — accounts exist only after a claim),
                    token_hash, created_at, expires_at (30 d sliding),
                    last_seen_at, revoked_at
                    -- opaque token in HttpOnly cookie; DB-backed, revocable

api_keys            id, user_id, registration_id, token_hash,
                    prefix (first ~8 chars plaintext, for display: "jh_live_k7Pq…"),
                    scopes, created_at, last_used_at, revoked_at

documents           id, slug (unique, 'fierce-tiger-12345'),
                    owner_id -> users, title, html TEXT (current content),
                    version int default 1,
                    is_public bool default false,
                    view_token ('k7Pq2xWmRb'),
                    created_at, updated_at, deleted_at

doc_versions        id, doc_id, version (int, unique per doc),
                    html TEXT (full snapshot),
                    author_user_id, edit_kind ('create'|'patch'|'rewrite'),
                    patch jsonb (the edits payload, when edit_kind='patch'),
                    created_at
                    -- powers history page + diff view + re-anchoring

doc_grants          id, doc_id,
                    grantee_type ('email'|'domain'),
                    grantee (citext: 'teammate@co.com' or 'co.com'),
                    role ('editor'|'commenter'|'viewer'),
                    created_by, created_at,
                    unique(doc_id, grantee_type, grantee)
                    -- v1 (editor sharing is a launch requirement)

-- phase 2 (designed now, built later)
comments            id, doc_id, author_user_id,
                    parent_id (1-level threads),
                    anchor jsonb (see "Comment anchoring" below; null = doc-level),
                    anchored_version int (doc version the anchor was computed against),
                    orphaned bool default false (anchor no longer resolves),
                    body, created_at, resolved_at, deleted_at

reactions           id, doc_id, comment_id (nullable),
                    author_user_id, emoji, created_at,
                    unique(target + author + emoji)
```

Notes:

- **Slugs** are adjective-noun-5digits and are NOT secrets. Guessing a slug gets
  you nothing on a private doc without the view token. Generate, retry on unique
  violation.
- **View token**: 10–12 chars from an unambiguous base58-ish alphabet (no
  `0/O/l/I`) → 60+ bits of entropy, short enough not to be ugly. Rotatable via
  API — rotation is the "un-share" story.
- **All secrets stored hashed** (OTP codes, claim tokens, API keys). Plaintext
  returned exactly once. The auth.md spec requires this anyway.

## Permissions model

Ordered from most to least privileged:

1. **Owner** — full control (the registered user; v1 has exactly one owner per doc).
2. **Editor grant** (v1) — edit + view via `doc_grants`. Cannot delete the
   doc, change visibility, rotate tokens, or manage grants.
3. **Commenter/viewer grant** (phase 2) — via `doc_grants`.
4. **View-token holder** — view, and in phase 2, comment + react.
5. **Public** — if `is_public`, anyone can view (and in phase 2, react;
   commenting on public docs TBD — likely requires email-verified session).

Grants target either an **email** or a **domain** (v1): "anyone with an
@kernel.sh email can edit/view/comment" = `{grantee_type: 'domain', grantee:
'kernel.sh', role: 'editor'}`. Resolution: explicit email grant beats domain
grant beats token/public. Guard: domain grants against consumer email
providers (gmail.com, outlook.com, yahoo.com, etc.) are rejected with an
error suggesting `is_public` or the view token instead — granting @gmail.com
is granting the world. Identity is always a verified email (auth.md OTP), so
domain membership is already proven; no new verification machinery.

**Sharing with a teammate's agent (v1 requirement)**: this falls out of the
email-based design with no extra machinery. Owner grants `editor` to
`teammate@co.com`. The teammate's agent registers via auth.md with that email
(their own OTP ceremony), gets their own API key, and the grant authorizes
their edits. Identity = email, agents act as their user, grants attach to
emails — three existing pieces, zero new ones.

Comment authorship needs identity: reuse the same email-OTP machinery to mint a
lightweight browser session cookie for human commenters. Reactions allowed for
anyone who can view; attributed if signed in.

## Comment anchoring (phase 2, designed now)

Comments can target a span of the document — a human click-drags to highlight;
an agent does the same thing via API by quoting. The anchor model is the W3C
Web Annotation selector pattern (TextQuoteSelector + TextPositionSelector):

```json
{
  "type": "text",
  "exact": "the highlighted passage, verbatim",
  "prefix": "~32 chars of text before, ",
  "suffix": ", ~32 chars of text after",
  "start": 1042,
  "end": 1153
}
```

- `exact` + `prefix`/`suffix` is the durable anchor: re-findable even when
  surrounding HTML shifts, disambiguates repeated text.
- `start`/`end` are offsets into the document's rendered text content — a
  fast-path hint, not authoritative.
- Anchoring is against text content, not DOM nodes, so spans crossing element
  boundaries are fine.
- `anchor: null` = doc-level comment.
- **Humans**: viewer shell captures `window.getSelection()`, computes
  exact/prefix/suffix/offsets, POSTs it.
- **Agents**: already have the HTML; they send the quote they want to comment
  on plus a little context. Same payload, same endpoint — an agent
  "highlights" by quoting.
### How anchors survive edits

Re-anchoring runs synchronously in the same transaction as every doc write
(docs are ≤2 MB and comment counts are small — this is cheap). Three tiers,
smartest first:

1. **Offset mapping through patches** (edit_kind='patch'): a search-replace
   edit gives exact changed ranges. Anchors entirely before an edit are
   untouched; anchors after shift by the length delta; only anchors
   *overlapping* an edited range fall through to tier 2. Most edits touch a
   small part of the doc, so most anchors survive this tier for free.
2. **Quote re-finding** (full rewrites, or tier-1 fallthrough): search the new
   text content for `exact`, scored by prefix/suffix agreement and proximity
   to the old position — same matching philosophy as the edit engine.
   Ambiguous (multiple equal-score matches) → don't guess, fall to tier 3.
3. **Orphan**: mark `orphaned` (kept, shown in the all-threads sidebar,
   unanchored) rather than deleting — same behavior as Google Docs. If a
   later edit restores the text, re-anchoring may un-orphan it.

On success, update the stored anchor offsets and `anchored_version`. We do
NOT get more intelligent than this in v1 (no semantic/LLM re-anchoring) —
tier 1 covers patch edits precisely, tier 2 covers rewrites honestly, and
orphaning is an acceptable, legible failure mode.

### All-threads view

The viewer shell's comment sidebar lists **every** thread (Google-Docs
style): anchored threads in document order, doc-level threads, then orphaned
threads in their own group; resolved threads behind a toggle. Clicking an
anchored thread scrolls to/flashes its highlight. `GET /comments` returns all
of this in one response (threads + anchors + orphan/resolved flags), so
agents get the same complete picture as humans.

### Comments & reactions API (phase 2)

| Method | Path                                   | Purpose                                  |
|--------|----------------------------------------|------------------------------------------|
| POST   | `/api/v1/docs/:slug/comments`          | `{body, anchor?, parent_id?}`            |
| GET    | `/api/v1/docs/:slug/comments`          | List (threads + anchors + orphan flags)  |
| PATCH  | `/api/v1/docs/:slug/comments/:id`      | Edit body / resolve / unresolve          |
| DELETE | `/api/v1/docs/:slug/comments/:id`      | Soft-delete                              |
| POST   | `/api/v1/docs/:slug/reactions`         | `{emoji, comment_id?}` (null = on doc)   |
| DELETE | `/api/v1/docs/:slug/reactions/:id`     | Remove own reaction                      |

Auth: API key (agents) or view-token-scoped browser session (humans), per the
permissions ladder above.

## Auth: auth.md protocol, user-claimed flow

Spec: https://workos.com/auth-md · https://workos.com/auth-md/docs/apps ·
https://github.com/workos/auth.md

**The detailed implementation spec — endpoints with exact JSON shapes,
registration state machine, TTLs, hashing rules, auth-flow rate limits, audit
events, email drafts, and draft discovery files — lives in
[authmd-implementation.md](./authmd-implementation.md).** This section is the
summary. (Kernel's production file at https://www.kernel.sh/auth.md is the
style reference for our prose auth.md.)

Implement the **`service_auth` (email-required) variant** of the user-claimed
flow, **spec-pure** (decided 2026-06-12 — the earlier emailed-OTP-read-back-
to-agent deviation is dropped):

1. Agent reads `justhtml.sh/auth.md` (prose) →
   `/.well-known/oauth-protected-resource` →
   `/.well-known/oauth-authorization-server` (carries the `agent_auth` block:
   `identity_endpoint`, `claim_endpoint`, `identity_types_supported`).
2. `POST /agent/identity` with `{type: "service_auth", login_hint: "<email>"}` →
   pending registration (NO user row yet), returns `claim_token` + claim
   metadata: `{user_code, verification_uri, expires_in, interval}`.
3. Agent shows the human the 6-digit `user_code` and the `verification_uri`
   link.
4. Human opens the verification page, signs in via email magic link (see
   "Sessions & human login" — the session email must match the
   registration's `login_hint`), and types the code into the hosted claim
   form (a plain HTML form, no JS).
5. Agent polls `POST /oauth2/token` with grant
   `urn:workos:agent-auth:grant-type:claim` (`authorization_pending` until
   done). On confirm: user row created/bound, long-lived API key issued.

The claim ceremony doubles as account creation AND leaves the human with a
logged-in browser session — one email click bootstraps both the agent's key
and the human's session.

**Deliberate deviations from spec** (full list with reasoning in
authmd-implementation.md §8):

- **Long-lived API key** (`jh_live_…`) instead of short-lived tokens with
  assertion re-exchange. Agents store a key in env/config and use it for
  weeks — hourly refresh ceremonies would make the product annoying. Keys
  revocable via endpoint (and a future dashboard). Issued **exactly once**
  per registration (spec lets claim tokens re-poll for fresh tokens; with a
  permanent key that must be locked). Scopes: `docs.read docs.write`.
- **No anonymous-start** — service_auth only. Pre-claim scopes buy nothing
  for a docs product, and pre/post-claim key reuse is a hazard the reference
  README itself flags (worse with long-lived keys).

(The claim ceremony itself is **spec-pure**: agent shows the code, human
enters it at our hosted verification form after signing in. An earlier draft
deviated by emailing the code for read-back to the agent — dropped
2026-06-12.)

Key TTLs (from the reference implementation): claim window 24 h, user code
10 min, poll interval 5 s.

**Rate limits** (per spec guidance): per-IP and per-email caps on registration
and code attempts; max 5 attempts per code. Simple Postgres counters — no Redis
at this scale.

## Sessions & human login

**Session state: DB-backed sessions in Postgres** (`sessions` table), opaque
random token (hashed at rest, like every other secret) in an
HttpOnly/Secure/SameSite=Lax cookie, 30-day sliding expiry, revocable by
deleting the row. No JWTs, no iron-session, no NextAuth — one indexed lookup
per authenticated page request, consistent with the hash-everything model.

Sessions are keyed by **verified email**, with `user_id` nullable — because
in the claim ceremony the human signs in *before* their account exists
(accounts are created only at claim confirm). A session with no user is
valid; it can confirm claims and, phase 2, comment.

**Login flow (humans)**: `/login` — enter email → we send a magic link
(single-use `login_tokens` row, 15 min TTL) → **clicking the link logs you
in** (mints session, redirects to `?next=` destination: claim form, a doc,
the dashboard). Used for: the claim ceremony's sign-in step, returning to
view private docs you own, and phase-2 commenting.

**Sign-up is agent-only.** `/login` never creates accounts. Signing in with
an unknown email works (you get a session — needed for the claim ceremony),
but the dashboard for account-less sessions says: "no account yet — tell
your agent to sign up at justhtml.sh/auth.md".

### Share notifications: the non-user grantee story (v1)

When an **email grant** is created, the grantee gets a man-page-style email
(subject: `<owner email> shared "<title>" with you — justhtml.sh`) with ONE
link that **logs them in and lands them on the doc**:

- The link is a single-use login token with `next=/d/:slug`, but with a
  **7-day TTL** (`kind='share'` on login_tokens) instead of the 15-minute
  login TTL — share emails get clicked tomorrow, not now. Same security
  anchor either way: possession of the inbox.
- No account needed: sessions are email-keyed with nullable user_id. A
  grantee who has never heard of justhtml.sh clicks once and is viewing.
- The email includes one line for the agent path: "to edit via API, tell
  your agent to register at justhtml.sh/auth.md with this email."
- `POST /grants` accepts `notify: false` to suppress it. **Domain grants
  never notify** (we don't email a whole company).
- Counts against the per-email send rate caps.

**Stale-link fallback (always works)**: the private-doc notice on `/d/:slug`
always offers "Was this shared with you? Sign in" → `/login?next=/d/:slug`.
So an expired/consumed share link degrades to one extra email round-trip,
never a dead end.

**Viewer-route enforcement** (explicit, not just implied by the ladder):
`/d/:slug` and `/d/:slug/raw` authorize in order: owner session → session
email matching an email grant → session email-domain matching a domain
grant → valid view token → public. Editor-granted humans see the doc; web
editing is not v1 (editing is API-only — their agent edits).

Both `/login` and the claim verification form are plain HTML forms served
from route handlers — zero JS, man-page styled. CSRF: SameSite=Lax plus
Origin-header check on mutating form POSTs. User-uploaded HTML can never
ride these sessions: the viewer iframe is sandboxed/origin-less, and `/raw`
responses carry no cookies semantics worth stealing.

**Emails are just html too.** Every email we send (login magic links — our
only email type) is handwritten plain HTML in the same man-page style as the
site: monospace, no images, no tracking pixels, no template framework. The
email IS the brand: `SUBJECT: justhtml.sh login` and a link.

## Document API

REST under `/api/v1`, `Authorization: Bearer jh_live_…`:

| Method | Path                              | Purpose                                   |
|--------|-----------------------------------|-------------------------------------------|
| POST   | `/api/v1/docs`                    | `{html, title?, public?}` → `{slug, url, view_token}` |
| GET    | `/api/v1/docs`                    | List own docs                             |
| GET    | `/api/v1/docs/:slug`              | Fetch metadata + html                     |
| PATCH  | `/api/v1/docs/:slug`              | Update html / title / public flag         |
| DELETE | `/api/v1/docs/:slug`              | Soft-delete                               |
| POST   | `/api/v1/docs/:slug/rotate-token` | New view token (the "un-share" action)    |
| POST   | `/api/v1/docs/:slug/edits`        | Apply patches (see "Editing" below)       |
| GET    | `/api/v1/docs/:slug/versions`     | List version history                      |
| GET    | `/api/v1/docs/:slug/versions/:n`  | Fetch a specific version's html           |
| POST   | `/api/v1/docs/:slug/grants`       | `{email, role}` or `{domain, role}` — share (owner only) |
| GET    | `/api/v1/docs/:slug/grants`       | List grants (owner only)                  |
| DELETE | `/api/v1/docs/:slug/grants/:id`   | Revoke a grant (owner only)               |

## Editing: patches, locking, history (v1)

**Patch API instead of full rewrites.** `POST /api/v1/docs/:slug/edits`:

```json
{
  "edits": [{ "oldText": "…", "newText": "…" }, …],
  "base_version": 7
}
```

Application is **deterministic** — vendor/adapt the logic from pi's
`edit-diff.ts` (https://github.com/earendil-works/pi, coding-agent edit tool):
exact `indexOf` match first, then a fuzzy fallback that normalizes trailing
whitespace, smart quotes, and unicode dashes/spaces. Empty oldText, no match,
multiple matches (ambiguity), and overlapping edits are all hard errors —
returned as a structured 422 naming the failing edit, so the calling agent can
retry with more context. This is exactly the Edit-tool contract every coding
agent already speaks; no server-side LLM in the apply path (slow, costly,
nondeterministic — revisit only if real-world match failure rates demand it).

`PATCH /docs/:slug` with full `html` remains available for rewrites.

**Concurrency control**, two layers, both via Postgres (no Redis/lease infra):

1. *Serialization*: every write does `SELECT … FOR UPDATE` on the documents
   row inside the transaction (read current html → apply edits → write new
   html + bump version + insert doc_versions row). Concurrent writers queue;
   transactions are short, so this is invisible in practice.
2. *Staleness detection*: optional `base_version` (or `If-Match`). If supplied
   and ≠ current version → **409** with the current version and a pointer to
   `/versions`, so the editor can re-read, re-derive edits, and retry. Agents
   should always send it; patches against stale content are how you get
   silently wrong merges.

**History**: every write inserts a full-snapshot `doc_versions` row (at a 2 MB
cap and ~10 GB on the PlanetScale plan, snapshots are a non-problem; add
retention/pruning only if it ever matters). Diffs are computed on demand, not
stored — the `patch` jsonb column records what was *requested*, snapshots
record what *resulted*.

- API: `GET /versions`, `GET /versions/:n` (above).
- UI: `/d/:slug/history` — version list + diff view rendered with
  **@pierre/diffs** (Shiki-based, React components, unified/split views).
  This is the second of the only two React surfaces (viewer shell, history).

## Limits (v1)

All enforced with Postgres counters (fixed window) — no Redis. Rate
violations return **429** with `Retry-After` and a structured JSON body;
quota violations return **413** (size) or **403 quota_exceeded** (counts/
storage) naming the limit and current usage, so agents can self-correct.

**Resource quotas (per user)**

| Limit                    | Value                | Notes                                |
|--------------------------|----------------------|--------------------------------------|
| Max HTML size per doc    | 2 MB                 | request body checked before parse    |
| Docs per user            | 500                  | soft-deleted docs don't count        |
| Versions retained per doc| 100                  | oldest snapshots pruned beyond this  |
| Total storage per user   | 100 MB               | current html + retained snapshots    |
| Comment body size        | 10 KB                | phase 2                              |
| Comments per doc         | 1,000                | phase 2                              |
| Grants per doc           | 50                   |                                      |
| API keys per user        | 10                   |                                      |

**API rate limits (per API key)**

| Operation                       | Limit       |
|---------------------------------|-------------|
| Doc creates                     | 60 / hour   |
| Writes (PATCH, /edits, grants)  | 60 / min    |
| Reads (GET)                     | 300 / min   |

**Unauthenticated** (viewer routes, per IP): 300 / min — generous; the
sandbox + token model is the real protection, this just caps scraping.

**Auth-flow limits** (registration, OTP attempts, claim polling) follow the
auth.md spec's recommendations and are specced in detail in
[authmd-implementation.md](./authmd-implementation.md).

These values are launch guesses, set conservative-but-unannoying; they live
in one config module so tuning is a one-line change. Limits are documented in
llms.txt and the OpenAPI spec so agents can plan around them.

## Viewer routes

Viewer routes (not under /api):

- `GET /d/:slug` — shell page: thin chrome (title, "made with justhtml.sh",
  later the comment sidebar) wrapping a sandboxed iframe.
- `GET /d/:slug/raw` — the actual HTML, served with
  `Content-Security-Policy: sandbox allow-scripts` + `X-Content-Type-Options:
  nosniff`. Directly linkable for zero-chrome viewing; same token rules.

**The one security decision that matters**: user HTML must never execute
same-origin with our auth/session surface, or any doc could exfiltrate other
users' view tokens / cookies. The `sandbox` CSP makes the raw response
origin-less. The shell+iframe split also gives us the mounting point for the
phase-2 comment overlay without touching user HTML.

## Agent discoverability

- `justhtml.sh/llms.txt` — terse: what this is, how to auth (points at
  auth.md), the doc endpoints with one curl example each.
- `justhtml.sh/api/spec.yaml` — OpenAPI 3.1, hand-written (~6 paths).
- `justhtml.sh/auth.md` — prose per spec: service name, flows supported,
  scopes, links to .well-known metadata.
- `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-authorization-server` — machine-readable discovery.
- 401 responses carry `WWW-Authenticate: Bearer resource_metadata="…"` so
  agents hitting the API cold can bootstrap.

## Homepage: plain HTML, man-page style

The homepage at `/` is itself basic HTML — man-page style, à la
https://httpbingo.org/. Monospace, no framework CSS, no JS required, and
**always light mode** (like httpbingo — no dark variant, no
prefers-color-scheme). It IS the docs: NAME / SYNOPSIS / DESCRIPTION /
AUTHENTICATION / ENDPOINTS / EXAMPLES sections, with full usage inline.

It should include one copy-pasteable prompt ("paste this to your agent") that
points the agent at auth.md + llms.txt — that prompt is the growth loop. The
product's homepage being just html is the brand.

**How, in Next.js**: don't use a React page. App Router supports plain route
handlers (`app/route.ts` for `/`) returning `new Response(htmlString)` —
handwritten HTML, zero React runtime, zero hydration, zero JS shipped. Same
technique serves `/auth.md`, `/llms.txt`, `/api/spec.yaml`, the `.well-known`
JSON, and `/d/:slug/raw`. React is used in exactly one place: the `/d/:slug`
viewer shell, where the phase-2 comment overlay (selection capture, sidebar)
genuinely needs JS. This is why we don't need a Go backend: every just-html
surface is literally just HTML off a handler.

## Build plan

**Phase 0 — provisioning** (✅ complete 2026-06-12)
1. ~~Database + hosting~~ — DONE: PlanetScale Postgres (PS-5, aws-us-east,
   db `justhtml`) via Stripe Projects; Vercel project `justhtml` created
   directly in the kernel team (`onkernel`) with env vars pushed and
   justhtml.sh attached + verified (same-team, instant). Credentials in
   local `.env`. (History: an initial Vercel project was provisioned via
   Stripe Projects in a separate team; it couldn't verify the domain and
   was deleted in favor of the kernel-team project.)
2. ~~Resend~~ — DONE (2026-06-12): `notify.justhtml.sh` verified, key in
   local `.env`; still needs adding to Vercel env at deploy time.
3. ~~Buy `justhtml.sh`~~ — DONE, purchased in Kernel's Vercel account
   (2026-06-12). Just attach it to the project.

**Phase 1 — core product** (re-cut 2026-06-12 into deployable increments;
each increment ships to production at justhtml.sh, is adversarially reviewed
against this plan, and live-QA'd before the next begins. Direct pushes to
main + prod — brand-new project, no backwards compatibility.)

- **B1 Foundation**: Next.js scaffold (route-handler-first), full v1 schema +
  migrations against PlanetScale, Vercel deploy pipeline (attach justhtml.sh,
  push env vars, prod deploy), placeholder man-page homepage.
  QA: https://justhtml.sh serves; schema matches plan.
- **B2 Auth**: sessions + `/login` magic links (Resend, man-page email),
  registration + spec-pure claim ceremony, `/oauth2/token` (claim grant) +
  `/oauth2/revoke`, `.well-known` discovery + `/auth.md`, auth-flow rate
  limits. Includes an **env-gated QA endpoint** (strong secret) to retrieve
  login links during automated tests — documented, removable post-launch.
  QA: full agent registration ceremony against production; negative cases
  (wrong code ×5, expiry, email mismatch, rate limits).
- **B3 Documents**: docs CRUD, slugs + view tokens, `/d/:slug` shell +
  `/d/:slug/raw` sandbox, doc_versions on every write, size/count quotas.
  QA: private/public doc lifecycle, sandbox CSP headers, token rotation.
- **B4 Editing**: `/edits` patch engine (vendored pi edit-diff), FOR UPDATE +
  base_version 409s, history API + `/d/:slug/history` (@pierre/diffs).
  QA: patches, ambiguity 422s, staleness 409s, concurrent writes, history UI.
- **B5 Sharing**: grants API (email + domain), editor enforcement,
  consumer-domain rejection. QA: second agent registers as a teammate
  (raf+qa-*@kernel.sh) and edits a shared doc.
- **B6 Discovery & polish**: llms.txt, `/api/spec.yaml` (OpenAPI 3.1),
  man-page homepage with the copy-pasteable agent prompt, API rate limits,
  run both acceptance tests end-to-end.

**Acceptance tests**:
- A fresh Claude session pointed only at `justhtml.sh` can register a user,
  get a key, publish a doc, and hand back a working private URL — with the
  only human steps being: click the login link in the email, type the code
  the agent showed you. The human ends up logged in as a side effect.
- Owner shares editor access to a second email; a second agent registers as
  that email and successfully patches the doc via `/edits`; the history page
  shows both versions with a correct diff.

**Phase 2 — light collaboration (later)**
- Comments (1-level threads, span anchoring per "Comment anchoring" above:
  click-drag highlight for humans, quote-based anchors via API for agents),
  resolve, delete, orphan handling.
- Emoji reactions on docs and comments.
- `doc_grants` API + email-OTP browser sessions for human commenters.
- Minimal "my docs" dashboard (list, revoke keys, rotate tokens) — also
  man-page styled.

## Open questions / decisions made

- ~~Go backend?~~ No — single Next.js app. Re-examined for the "homepage must
  be plain HTML" requirement: route handlers serve zero-JS HTML fine, so
  Next.js survives the vibe check.
- ~~Comment location model?~~ W3C-style text-quote selectors with position
  hints; spans supported; same payload for humans (click-drag) and agents
  (quote via API). See "Comment anchoring".
- ~~Edit access in sharing?~~ Yes, v1: `editor` role in doc_grants; a
  teammate's agent edits by registering via auth.md as that teammate.
- ~~Patch application: LLM or deterministic?~~ Deterministic (vendored pi
  edit-diff: exact-then-fuzzy, hard errors on ambiguity). Structured 422s let
  the calling agent retry — it's already an LLM; we don't need one server-side.
- ~~Edit locking?~~ Postgres only: `SELECT FOR UPDATE` serializes writes;
  optional `base_version`/`If-Match` → 409 for staleness. No lock service.
- ~~History storage?~~ Full snapshots per version in doc_versions; diffs
  computed on demand, rendered with @pierre/diffs on `/d/:slug/history`.
- ~~Anchors vs edits?~~ Three tiers: offset-mapping through patches → quote
  re-finding → orphan. No LLM re-anchoring in v1.
- ~~Domain-wide sharing?~~ Yes, v1: grants target email OR domain
  (`@kernel.sh` → role). Consumer email domains rejected.
- ~~Limits?~~ See "Limits (v1)": 2 MB/doc, 500 docs + 100 MB/user, 100
  versions/doc, write/read rate limits per key, Postgres-counter enforcement.
  Auth-flow limits per the auth.md spec, detailed in authmd-implementation.md.
- ~~All deps via Stripe Projects?~~ All except email. Decided 2026-06-12:
  PlanetScale + Vercel via Projects; Resend manual signup (not in catalog);
  domain via Vercel Domains API.
- ~~Anonymous-start registration?~~ No — service_auth only (see deviations).
- ~~Claim ceremony: emailed OTP or spec-pure?~~ **Spec-pure** (2026-06-12):
  agent shows code, human enters it at our hosted form after magic-link
  sign-in. Resend now sends login links, not claim codes.
- ~~Session state?~~ DB-backed sessions table, opaque hashed token in
  HttpOnly cookie, keyed by verified email (user_id nullable). No
  JWT/NextAuth. Magic-link click = login. Sign-up remains agent-only.
- ~~Non-user grantee story?~~ (2026-06-12) Email grants send a share
  notification with a one-click 7-day login+redirect link; stale links
  degrade to sign-in-from-the-private-notice; viewer routes authorize by
  session-email grants, not just view tokens. See "Share notifications".
- ~~Registration status column?~~ No — derived from claimed_at/
  claim_expires_at, per the reference implementation. No sweeper jobs.
- ~~Object storage?~~ No — Postgres TEXT with 2 MB cap.
- Long-lived API key vs spec-pure short-lived tokens → **long-lived key**
  (deliberate deviation, documented above).
- `/d/:slug/raw` directly linkable → **yes**, same token rules.
- Commenting identity on public docs → TBD in phase 2 (likely email-verified
  session required to comment; reactions anonymous-allowed).
