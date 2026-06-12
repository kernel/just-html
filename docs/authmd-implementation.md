# auth.md implementation spec — justhtml.sh

Status: ready to build from. Companion to `docs/birthday.md` (product plan, data
model). Revised 2026-06-12: the claim ceremony is now **spec-pure** (agent shows the
code, human enters it at our hosted form after magic-link sign-in); the earlier
emailed-OTP-read-back-to-agent variant is dropped. Sessions & human login are now
specified here (§9).

## 0. Sources

All values in this document are cited to one of:

- **[REPO]** `github.com/workos/auth.md` (cloned 2026-06-12). Contents: the protocol
  spec as a procedural agent recipe (`AUTH.md`), a **TypeScript/Express reference
  implementation of the service side** (`agent-services/` — routes, in-memory store,
  token/code minting and hashing), a reference agent IdP (`agent-providers/`, ID-JAG
  minting — not relevant to us), and a service implementer guide with the rate-limit
  and audit guidance (`agent-services/README.md`). The reference implementation is
  real, working code; cited as e.g. `[REPO agent-services/src/config.ts]`.
- **[DOCS]** `https://workos.com/auth-md/docs` and `https://workos.com/auth-md/docs/apps`
  (fetched 2026-06-12). The `/apps` page mirrors `agent-services/README.md` almost
  exactly, including the rate-limit numbers.
- **[KERNEL]** `https://www.kernel.sh/auth.md` (fetched 2026-06-12, verbatim). A
  production auth.md; the style reference for our prose file. Note kernel.sh
  *deviates* from the spec ceremony (it emails the OTP and has the human read it back
  to the agent); we considered and **dropped** that variant — see §8.
- **[PLAN]** `docs/birthday.md` in this repo — the authoritative product decisions
  ("Auth: auth.md protocol" and "Sessions & human login" sections).

Things the sources do **not** specify, where this doc makes a choice (each marked
"OUR CHOICE" inline): the per-code attempt cap (spec says only "tight per-claim retry
limits" [DOCS /apps]), exact per-IP limits for `service_auth` (spec gives numbers
only for `anonymous` and `identity_assertion`), and everything about magic-link
login (the spec assumes the service already has a sign-in system; ours is specified
in §9 and its limits are entirely OUR CHOICE).

Two findings worth flagging before the spec proper:

1. **The reference implementation has no rate limiting code and no attempt counters.**
   The store is in-memory and the README says `slow_down` enforcement was "omitted from
   this demo" [REPO agent-services/src/routes/token.ts, comment at the
   `authorization_pending` branch]. All rate-limit values come from prose guidance in
   `agent-services/README.md` / [DOCS /apps], not from enforced code.
2. **In the spec-pure flow the service never emails the code.** The `user_code`
   travels agent → user, and the user types it into a service page after signing in
   ([REPO AUTH.md Step 4]; [DOCS /flows/claimed]: "Your service never emails the
   code"). **That is the flow we build.** The only email justhtml.sh sends is the
   login magic link (§9), which is our own session machinery, not part of the
   auth.md ceremony.

---

## 1. Protocol overview as applied to justhtml.sh

auth.md ("agentic registration") defines three registration methods at a single
endpoint, `POST /agent/identity`, dispatched on `type` [REPO AUTH.md Step 2/3]:

| type                 | What it is                                            | justhtml.sh |
|----------------------|-------------------------------------------------------|-------------|
| `identity_assertion` | Provider-signed ID-JAG JWT (OpenAI/Anthropic/etc. attest the user) | **Not supported** (v1) |
| `service_auth`       | Agent has only the user's email; claim ceremony required | **Supported — the flow** |
| `anonymous`          | No identity; pre-claim scopes now, optional claim later | **Not supported** (v1) |

### Flow we implement (service_auth, user-claimed, spec-pure)

1. Agent reads `https://justhtml.sh/auth.md` → PRM → AS metadata (`agent_auth` block).
2. `POST /agent/identity` `{"type":"service_auth","login_hint":"user@example.com"}` →
   creates a pending registration (**no user row yet**), returns `claim_token` + a
   `claim` ceremony block: `{user_code, verification_uri, expires_in, interval}`.
3. Agent surfaces **both** the 6-digit `user_code` and the `verification_uri` to the
   human, in one message — suggested copy per [REPO AUTH.md §4b]: "Open this link,
   sign in, and enter this 6-digit code: **428117**".
4. Human opens the `verification_uri`, signs in via email magic link (§9 — the
   session email must match the registration's email), and types the code into our
   hosted claim form (plain HTML, no JS).
5. Agent polls `POST /oauth2/token` with
   `grant_type=urn:workos:agent-auth:grant-type:claim` every `interval` (5 s),
   getting `authorization_pending` until the form is submitted. On confirm: user row
   created/bound, and the poll returns the credential — a long-lived `jh_live_…` API
   key with scopes `docs.read docs.write` (deviation — §8).

The ceremony doubles as account creation AND leaves the human with a logged-in
browser session — one email click bootstraps both the agent's key and the human's
session [PLAN].

### Should we also support anonymous-start? **No (v1).** Reasoning:

- The reference implementation supports it via a pre-claim scope set (`api.read` only)
  and revokes all pre-claim tokens when the claim completes
  [REPO agent-services/src/store.ts `completeClaim`, config `preClaimScopes`]. For
  justhtml.sh a pre-claim agent could hold `docs.read` but owns no docs — there is
  nothing useful to read. The pre-claim state buys zero product value.
- It adds real machinery: a pre-claim principal state, a scope-set swap at claim time,
  and mandatory revocation of pre-claim credentials — plus the documented security
  wart that "anyone who captured the API key pre-claim retains access post-claim with
  the new scopes" [REPO agent-services/README.md, Security Considerations], which is
  worse for us because our keys are long-lived.
- kernel.sh also ships without it: "It does not currently support agent-verified
  ID-JAG registration, or anonymous accounts" [KERNEL].
- The protocol handles opt-out cleanly: we advertise only `service_auth` in
  `identity_types_supported` and return `anonymous_not_enabled` if an agent sends it
  anyway [REPO AUTH.md error table].

`identity_assertion`/ID-JAG is likewise deferred (needs a provider trust list, JWKS
fetching/caching, `jti` replay cache, step-up ceremony). The schema in §10 doesn't
preclude adding either later.

---

## 2. Discovery artifacts (literal content)

Single host: `https://justhtml.sh` is both resource server and authorization server
(the reference impl also runs both on one origin [REPO agent-services/src/config.ts]).
The domain is already purchased, in Kernel's Vercel account [PLAN] — attach it to
the Vercel project; no acquisition step.

Serve all three from plain Next.js route handlers. Discovery JSON gets
`Cache-Control: public, max-age=300` [REPO agent-services/src/routes/well-known.ts].
`auth.md` is served as `text/markdown; charset=utf-8`
[REPO agent-services/src/routes/auth-md.ts].

> Next.js note: route handlers at `app/.well-known/oauth-protected-resource/route.ts`
> work in current App Router versions; if the dot-directory misbehaves in dev, fall
> back to `app/well-known/...` plus a `rewrites()` entry in `next.config.ts` mapping
> `/.well-known/:path*` → `/well-known/:path*`. Verify in dev before relying on the
> dot-directory.

### 2.1 `GET /.well-known/oauth-protected-resource` (RFC 9728)

```json
{
  "resource": "https://justhtml.sh/api/v1/",
  "resource_name": "justhtml.sh",
  "authorization_servers": ["https://justhtml.sh"],
  "scopes_supported": ["docs.read", "docs.write"],
  "bearer_methods_supported": ["header"]
}
```

Shape per [REPO agent-services/src/routes/well-known.ts] / [DOCS /apps]. We omit
`resource_logo_uri` (optional; we have no logo at launch — add it when one exists,
agents surface it during consent [REPO AUTH.md §1a]).

### 2.2 `GET /.well-known/oauth-authorization-server` (RFC 8414 + `agent_auth` profile block)

```json
{
  "resource": "https://justhtml.sh/api/v1/",
  "authorization_servers": ["https://justhtml.sh"],
  "scopes_supported": ["docs.read", "docs.write"],
  "bearer_methods_supported": ["header"],

  "issuer": "https://justhtml.sh",
  "token_endpoint": "https://justhtml.sh/oauth2/token",
  "revocation_endpoint": "https://justhtml.sh/oauth2/revoke",
  "grant_types_supported": [
    "urn:workos:agent-auth:grant-type:claim"
  ],

  "agent_auth": {
    "skill": "https://justhtml.sh/auth.md",
    "identity_endpoint": "https://justhtml.sh/agent/identity",
    "claim_endpoint": "https://justhtml.sh/agent/identity/claim",
    "identity_types_supported": ["service_auth"],
    "credential_types_supported": ["api_key"]
  }
}
```

Differences from the reference shape [REPO agent-services/src/routes/well-known.ts],
all deliberate (§8):

- `grant_types_supported` omits `urn:ietf:params:oauth:grant-type:jwt-bearer` — we
  issue API keys, not assertions, so there is nothing to re-exchange.
- `agent_auth` omits `events_endpoint`, `events_supported`, and the
  `identity_assertion` sub-block — no ID-JAG support means no SET receiver and no
  assertion types. [DOCS /apps]: "Advertise only supported registration types."
  kernel.sh does the same ("Kernel does not advertise `agent_auth.claim_uri` because
  anonymous claim initiation is not supported" [KERNEL]).
- `credential_types_supported: ["api_key"]` is a kernel.sh-style extension field
  ([KERNEL] advertises "supported credential type: `api_key`") signaling that the
  claim grant returns a long-lived key, not a short-lived access_token.
- `identity_types_supported: ["service_auth"]` (we keep `claim_endpoint` advertised
  because we use it for user_code re-mints — see §3.2).

### 2.3 `GET /auth.md` — full draft (style modeled on kernel.sh [KERNEL]; flow per [REPO AUTH.md])

```markdown
# justhtml.sh auth.md

This file tells agents how to sign up for justhtml.sh and authenticate API requests.

justhtml.sh hosts HTML documents at stable URLs. It supports the auth.md
user-claimed flow (service_auth variant): you register with the human's email,
show the human a 6-digit code and a link, and the human confirms in their
browser. It does not currently support agent-verified ID-JAG registration or
anonymous accounts.

## Before registering

Check for an existing justhtml.sh API key first:

1. Read `JUSTHTML_API_KEY` from the process environment.
2. If you are operating inside a project and the human permits it, read
   `JUSTHTML_API_KEY` from a local `.env` file. Never commit it.
3. Read `~/.justhtml/credentials` if it exists, has mode `0600`, and contains JSON
   like:

    {
      "api_key": "jh_live_...",
      "created_at": "2026-06-12T00:00:00Z",
      "source": "auth.md"
    }

If you find a candidate key, make a harmless authenticated request such as
`GET https://justhtml.sh/api/v1/docs?limit=1`. If it succeeds, use that key. If it
returns 401, discard the stale key and start the flow below.

## Discovery metadata

justhtml.sh publishes OAuth-style metadata at:

- `https://justhtml.sh/.well-known/oauth-protected-resource`
- `https://justhtml.sh/.well-known/oauth-authorization-server`

The authorization server metadata contains:

- `agent_auth.skill`: `https://justhtml.sh/auth.md`
- `agent_auth.identity_endpoint`: `https://justhtml.sh/agent/identity`
- `agent_auth.claim_endpoint`: `https://justhtml.sh/agent/identity/claim`
- supported identity type: `service_auth`
- supported credential type: `api_key`

Do not hard-code endpoint paths from examples on other services. Use this file and
the metadata.

## Registration flow

Ask the human for consent to create or recover justhtml.sh API credentials for
their email address, and tell them the key will carry scopes `docs.read docs.write`
(publish and edit HTML documents as them).

Start registration:

    POST https://justhtml.sh/agent/identity
    Content-Type: application/json

    { "type": "service_auth", "login_hint": "human@example.com" }

The response contains a `claim_token` (hold it in memory only; never show it to
anyone except this service) and a `claim` block with a 6-digit `user_code` and a
`verification_uri`.

Surface both to the human in a single message. Suggested copy:

> Open this link, sign in (you'll get a login email — click it), and enter this
> 6-digit code: **428117**
> https://justhtml.sh/login?next=%2Fclaim%3Fclaim_attempt_token%3D...

Be explicit that the code goes into the page they land on — not back to you.

While the human does that, poll for completion:

    POST https://justhtml.sh/oauth2/token
    Content-Type: application/x-www-form-urlencoded

    grant_type=urn:workos:agent-auth:grant-type:claim&claim_token=clm_...

While the human hasn't finished, this returns
`{ "error": "authorization_pending" }` — wait `claim.interval` seconds (5) and
retry. On `slow_down`, add at least 5 seconds to your interval. On success the
response contains `access_token` — a long-lived API key starting with `jh_live_`,
returned exactly once. There is no refresh ceremony; the key works until revoked.

If the code expires before the human enters it (`expired_token` from the token
endpoint while the registration is still active), mint a fresh one:

    POST https://justhtml.sh/agent/identity/claim
    Content-Type: application/json

    { "claim_token": "clm_...", "email": "human@example.com" }

then surface the new code + link to the human and resume polling. If that returns
`410 claim_expired`, the registration itself has expired — restart registration.

## Use the credential

    GET https://justhtml.sh/api/v1/docs
    Authorization: Bearer jh_live_...

To revoke a key: POST `token=<key>` (form-encoded) to
`https://justhtml.sh/oauth2/revoke`.

## Store the credential

Store the `access_token` in the best available secret store for your platform. If
the human allows file storage: `~/.justhtml/credentials`, mode `0600`, format shown
above. Never print the API key in logs, chat, commits, pull requests, generated
docs, or tool output.

If a later request returns 401, discard the stale credential and restart discovery
from this file.

Full API reference: `https://justhtml.sh/llms.txt` and
`https://justhtml.sh/api/spec.yaml`.
```

---

## 3. Endpoints (agent-facing)

### Next.js route handler mapping

| Endpoint | Method | Handler file | Spec'd in |
|---|---|---|---|
| `/.well-known/oauth-protected-resource` | GET | `app/.well-known/oauth-protected-resource/route.ts` | §2.1 |
| `/.well-known/oauth-authorization-server` | GET | `app/.well-known/oauth-authorization-server/route.ts` | §2.2 |
| `/auth.md` | GET | `app/auth.md/route.ts` | §2.3 |
| `/agent/identity` | POST | `app/agent/identity/route.ts` | §3.1 |
| `/agent/identity/claim` | POST | `app/agent/identity/claim/route.ts` | §3.2 |
| `/oauth2/token` | POST | `app/oauth2/token/route.ts` | §3.3 |
| `/oauth2/revoke` | POST | `app/oauth2/revoke/route.ts` | §3.4 |
| `/login` | GET, POST | `app/login/route.ts` | §9.2 (browser) |
| `/login/verify` | GET, POST | `app/login/verify/route.ts` | §9.2 (browser) |
| `/claim` | GET, POST | `app/claim/route.ts` | §9.3 (browser) |

Conventions, agent-facing endpoints:

- `/agent/identity*` endpoints speak JSON and use `{ "error": "...", "message": "..." }`
  error bodies (note: `message`, **not** `error_description` — this is what the
  reference impl emits at these endpoints [REPO agent-services/src/routes/agent-auth.ts
  lines 42, 221, 266]).
- `/oauth2/*` endpoints accept `application/x-www-form-urlencoded` and use OAuth
  envelopes `{ "error": "...", "error_description": "..." }`; every response (success
  and error) carries `Cache-Control: no-store` and `Pragma: no-cache` per RFC 6749
  §5.1 [REPO agent-services/src/routes/token.ts `setOAuthHeaders`].
- All 429s: see §6 for the shape.

### 3.1 `POST /agent/identity`

> **HYBRID CLAIM (2026-06-12, post-dogfood — NEW DEFAULT).** This endpoint now
> takes `claim_delivery`: `"email"` (the **new default**) or `"agent"` (the
> spec-pure behavior described in the rest of this section, kept exactly as-is).
> Mutually exclusive, fixed at registration time. In `email` mode the `user_code`
> is **omitted from the response** — justhtml.sh emails the login_hint a 6-digit
> code AND a one-click approve link (binding proof = inbox possession). The
> human either clicks approve (→ confirms the claim AND mints a logged-in
> session, lands on `/docs` — same GET-confirm/POST-consume pattern as
> `/login/verify`, served at `GET|POST /claim/approve`) or reads the code back
> to the agent for `POST /agent/identity/claim/complete` (§3.2.1). Either path,
> the agent's `/oauth2/token` claim-grant poll then returns the key (unchanged).
> Email-mode registration sends an email, so the email-send caps (§6 rows 11–13)
> apply on top of the registration caps. The text below documents the spec-pure
> `agent` mode; `email` mode differs only in the response `claim` block (no
> `user_code`/`verification_uri`; carries `delivery`, `code_delivery`,
> `complete_url`) and the email send. See `docs/birthday.md` "Claim delivery
> modes" for the product rationale.

Request (spec-pure `agent` mode; `email` is the default if `claim_delivery` is omitted):

```json
{ "type": "service_auth", "login_hint": "raf@kernel.sh", "claim_delivery": "agent" }
```

Server behavior, in order:

1. Rate-limit checks (per-IP, then per-email, then global — §6). On trip → 429.
2. Validate body. `login_hint` must match an email shape (reference uses
   `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` [REPO agent-services/src/store.ts `classifyLoginHint`]).
3. Create the registration row: `reg_` + 16 random bytes base64url id, type
   `service_auth`, `email` = login_hint, outer claim window = now + **86 400 s**
   [REPO agent-services/src/config.ts `anonymousTtlSeconds: 86400` — the same TTL is
   applied to service_auth registrations in `createServiceAuthRegistration`].
   **Do not create the user yet** (see §10) — accounts are created at claim confirm.
4. Mint three secrets [REPO agent-services/src/store.ts
   `createServiceAuthRegistration` + `mintUserCode`; hashing rule per
   README Security Considerations]:
   - `claim_token` = `clm_` + 19 random bytes base64url (≈26 chars). Store SHA-256
     only. Returned to the agent exactly once.
   - `claim_attempt_token` = `cvt_` + 24 random bytes base64url. Store SHA-256 only.
     Embedded in `verification_uri`, never returned bare.
   - `user_code` = `crypto.randomInt(0, 1_000_000)` zero-padded to 6 digits. Store
     SHA-256 only. TTL **600 s** [REPO config `userCodeTtlSeconds: 600`]. Returned
     to the agent (the agent shows it to the human — the code never travels via
     email; spec-pure, [DOCS /flows/claimed]).
5. Audit: `registration.created`, `user_code.minted` (§7).

No email is sent at registration. The only email in the whole system is the login
magic link, sent when the human submits their address at `/login` (§9).

Response `200` (shape per [REPO AUTH.md §service_auth] and
[REPO agent-services/src/routes/agent-auth.ts `handleServiceAuth`], with our URLs):

```json
{
  "registration_id": "reg_8Qb1xWmRk7Pq2zJv4Lt9nA",
  "registration_type": "service_auth",
  "claim_url": "https://justhtml.sh/agent/identity/claim",
  "claim_token": "clm_x9F2kQ7Rb1zJv4Lt8nWmA3pY5s",
  "claim_token_expires": "2026-06-13T17:31:25.994Z",
  "post_claim_scopes": ["docs.read", "docs.write"],
  "claim": {
    "user_code": "428117",
    "expires_in": 600,
    "verification_uri": "https://justhtml.sh/login?next=%2Fclaim%3Fclaim_attempt_token%3Dcvt_...",
    "interval": 5
  }
}
```

`verification_uri` routes through `/login` first, exactly as the reference builds it
(`/login?return_to=%2Fclaim%3F...` [REPO agent-services/src/routes/agent-auth.ts
`buildVerificationUri`]) — ours uses the `next` query param (§9). The
`claim_attempt_token` in the wrapped path identifies the registration without
leaking the user-typed `user_code` into history or link previews
[REPO AUTH.md §service_auth].

Errors:

| Status | Body | When |
|---|---|---|
| 400 | `{ "error": "invalid_request", "message": "<zod-style path: issue list>" }` | Body shape wrong [REPO agent-auth.ts:42] |
| 400 | `{ "error": "invalid_login_hint", "message": "login_hint must be a recognizable identifier (e.g. an email address)." }` | Bad email [REPO agent-auth.ts:221] |
| 400 | `{ "error": "anonymous_not_enabled", "message": "This service requires a user email. Re-register with type service_auth." }` | `type: "anonymous"` [REPO AUTH.md error table] |
| 400 | `{ "error": "issuer_not_enabled", "message": "identity_assertion is not supported. Re-register with type service_auth." }` | `type: "identity_assertion"` [REPO AUTH.md error table — closest defined code] |
| 429 | §6 shape + `Retry-After` | Rate limited |

### 3.2 `POST /agent/identity/claim` — re-mint a user_code

In the spec, service_auth registrations hit this endpoint for **refresh only** (the
initial ceremony is bundled into the registration response)
[REPO agent-services/src/routes/agent-auth.ts comment above the claim handler]. Same
for us: the agent calls this when the token endpoint returns `expired_token` but the
24 h registration window is still open. Each call invalidates the prior
`claim_attempt_token` + `user_code` and mints fresh ones
[REPO store.ts `recordClaimAttempt` replaces `claim.attempt` wholesale]; the agent
must re-surface the new code + link to the human.

Request:

```json
{ "claim_token": "clm_x9F2kQ7Rb1zJv4Lt8nWmA3pY5s", "email": "raf@kernel.sh" }
```

The per-attempt email may differ from the original `login_hint` — the reference
treats the hint as per-attempt so a re-mint can carry a corrected address
[REPO store.ts `RegistrationClaimAttempt.login_hint` comment]. For us a corrected
email **updates `agent_registrations.email`** (the registration isn't claimed yet —
the binding is still just a hint), and the claim form enforces the updated value.

Response `200` (shape per [REPO AUTH.md §4a] / [REPO agent-auth.ts claim handler]):

```json
{
  "registration_id": "reg_8Qb1xWmRk7Pq2zJv4Lt9nA",
  "claim_attempt_id": "cla_2Jv4Lt8nWmA3pY5sx9F2kQ",
  "status": "initiated",
  "expires_at": "2026-06-12T18:10:00.000Z",
  "claim_attempt": {
    "user_code": "915402",
    "expires_in": 600,
    "verification_uri": "https://justhtml.sh/login?next=%2Fclaim%3Fclaim_attempt_token%3Dcvt_...",
    "interval": 5
  }
}
```

(`expires_at` is the attempt's expiry, i.e. the view-token window — the reference
returns `attempt.view_expires_at` here [REPO agent-auth.ts:312].)

Errors (statuses exactly as the reference implements them [REPO agent-auth.ts:263–291]):

| Status | Body | When |
|---|---|---|
| 400 | `{ "error": "invalid_request", "message": "..." }` | Body shape |
| 401 | `{ "error": "invalid_claim_token", "message": "The claim token is invalid." }` | Unknown `sha256(claim_token)` |
| 409 | `{ "error": "claimed_or_in_flight", "message": "This registration has already been claimed." }` | Already claimed |
| 410 | `{ "error": "claim_expired", "message": "Registration has expired." }` | Outer 24 h window closed |
| 429 | §6 | Per-IP / re-mint caps |

### 3.2.1 `POST /agent/identity/claim/complete` — agent read-back (B9, email mode only)

New endpoint for the hybrid claim's read-back completion. For
`claim_delivery=email` registrations only: the human reads the 6-digit code from
the claim email back to the agent, and the agent submits it here. Confirms the
claim **without a browser session** (the binding proof is that the code reached
the human only via their inbox). Constant-time compare (§5.2); shares the code's
**5-attempt budget** with the `/claim` form and the `/claim/approve` link (all
touch `claim_codes.attempts` / `consumed_at` on the same live attempt row).

Request:

```json
{ "claim_token": "clm_...", "user_code": "428117" }
```

Behavior: resolve registration by `sha256(claim_token)`; reject
`claim_delivery=agent` (the human enters the code at the hosted form, no
read-back); increment-then-compare the live attempt's code; on match, confirm in
one transaction (find-or-create user, bind registration, **no session backfill**
— no browser here). On success the agent's `/oauth2/token` poll returns the key.

| Status | `error` | When |
|---|---|---|
| 200 | — | `{ registration_id, status: "claimed", message }` |
| 400 | `invalid_request` | Bad body / non-6-digit user_code |
| 401 | `invalid_claim_token` | Unknown `sha256(claim_token)` |
| 401 | `invalid_user_code` | Wrong code, attempts < 5 (message names remaining) |
| 409 | `wrong_delivery_mode` | Registration is `claim_delivery=agent` |
| 409 | `claimed_or_in_flight` | Already claimed |
| 410 | `code_dead` | 5 wrong attempts — code consumed; re-mint |
| 410 | `expired_token` | user_code window closed / no live code |
| 410 | `claim_expired` | Outer 24 h window closed |
| 429 | §6 | Per-IP read-back cap (30/h) |

The **approve link** completion is at `GET|POST /claim/approve?token=cva_…` (a
browser surface, §9.3.1), not this endpoint.

### 3.3 `POST /oauth2/token` — claim grant (polling + credential issuance)

Form-encoded [REPO AUTH.md §4c]:

```
grant_type=urn:workos:agent-auth:grant-type:claim&claim_token=clm_...
```

Dispatch on `grant_type`; anything other than the claim grant →
`unsupported_grant_type` (we drop jwt-bearer, §8.1). Handler logic mirrors
[REPO agent-services/src/routes/token.ts `handleClaimGrant`]:

1. Look up registration by `sha256(claim_token)`. Absent → `expired_token`
   ("Unknown or expired claim_token." — note the reference deliberately does *not*
   distinguish unknown from expired here, no enumeration signal).
2. Registration expired → `expired_token` ("The claim ceremony window has closed.").
3. Not yet claimed:
   - If the current attempt's `user_code` window has closed **or the code is dead
     from attempt exhaustion (§9.3)** → `expired_token` ("The user_code window has
     closed. Re-initiate the claim ceremony at the claim_endpoint.") — this tells
     the agent to re-mint rather than poll forever [REPO token.ts:167–183 comment;
     exhaustion mapping is OUR CHOICE, spec has no attempt cap].
   - Polled again less than **5 s** after the previous poll → `slow_down` (we
     implement what the reference documents but omitted: track `last_polled_at` per
     registration; agent must add ≥5 s to its interval [REPO AUTH.md error table]).
   - Otherwise → `authorization_pending` ("The user has not yet completed the
     ceremony.").
4. Claimed → mint the API key (first successful poll only — subsequent polls with the
   same claim_token return `invalid_grant`, "credential already issued"; OUR CHOICE,
   needed because unlike short-lived access_tokens a long-lived key must be minted
   exactly once. Set `credential_issued_at` on issuance.)
5. Audit: `token.issued`.

Pending response `400`:

```json
{ "error": "authorization_pending", "error_description": "The user has not yet completed the ceremony." }
```

(All claim-grant non-success responses are HTTP 400 with the OAuth envelope —
RFC 8628 §3.5 semantics over RFC 6749 error transport
[REPO token.ts `oauthError`: 400 for everything except `invalid_client` → 401].)

Success response `200` + `Cache-Control: no-store`:

```json
{
  "access_token": "jh_live_k7Pq2xWmRb1zJv4Lt8nA3pY5sx9F2kQ7Rb1zJv4L",
  "token_type": "Bearer",
  "scope": "docs.read docs.write",
  "credential_type": "api_key",
  "registration_id": "reg_8Qb1xWmRk7Pq2zJv4Lt9nA"
}
```

Deviations from the spec success shape [REPO AUTH.md §4c]: no `expires_in` (RFC 6749
§5.1 makes it optional; the key does not expire), no `identity_assertion` /
`assertion_expires` (nothing to re-exchange), added `credential_type` and
`registration_id` (kernel.sh-style clarity [KERNEL]). See §8.1.

Errors:

| Status | Body (`error` / `error_description`) | When |
|---|---|---|
| 400 | `unsupported_grant_type` / "Unsupported grant_type: …." or "Missing grant_type." | Wrong/missing grant [REPO token.ts:96–100] |
| 400 | `invalid_request` / "claim_token: …" | Missing claim_token |
| 400 | `authorization_pending` | Waiting on user |
| 400 | `slow_down` | Polled < 5 s apart |
| 400 | `expired_token` | Unknown token, user_code window closed/exhausted, or registration expired (descriptions above) |
| 400 | `invalid_grant` / "Credential already issued for this registration." | Re-poll after issuance (ours) |
| 429 | §6 | Per-IP cap |

### 3.4 `POST /oauth2/revoke` (RFC 7009)

Form-encoded: `token=jh_live_...&token_type_hint=access_token`
(`token_type_hint` optional [REPO schemas.ts `revocationEndpointBody`]).

- Hash the token, set `api_keys.revoked_at`. Return **200 with empty body** whether
  or not the token existed or was already revoked — idempotent, no enumeration
  [REPO token.ts revoke handler; RFC 7009 §2.2 per agent-services/README.md].
- 400 `{ "error": "invalid_request", "error_description": "..." }` only for a
  malformed body.
- `Cache-Control: no-store` on all responses.
- Audit: `token.revoked` (only when a key actually flipped).

### 3.5 API 401 contract (resource side)

Every 401 from `/api/v1/*` carries the discovery hint
[REPO agent-services/src/auth.ts `setChallenge`; AUTH.md Step 1]:

```
WWW-Authenticate: Bearer resource_metadata="https://justhtml.sh/.well-known/oauth-protected-resource"
```

Body: `{ "error": "unauthorized", "message": "Invalid, expired, or revoked credential." }`
(or "Missing Bearer credential."). Token extraction: `/^Bearer\s+(.+)$/i` on the
`Authorization` header [REPO auth.ts].

---

## 4. Registration state machine

States are **derived**, not stored — the reference computes status from
`claimed_at` / `claim.expires_at` / attempt presence and notes this avoids a sweeper
job [REPO agent-services/src/store.ts `Registration.status` getter]; [PLAN] adopts
this ("status is DERIVED … no sweeper jobs"). For service_auth an attempt always
exists, so `unclaimed` is unreachable; effective states:

```
                      POST /agent/identity
                              │
                              ▼
                       ┌──────────────┐  POST /agent/identity/claim
                       │ pending_claim│◄──── (re-mint: new cvt_ + code,
                       │              │       possibly corrected email;
                       └──────┬───────┘       old ones die)
        claimed_at set ◄──────┤
   (code verified at the      │ claim.expires_at passes (24 h)
    hosted /claim form, §9.3) ▼
        ┌─────────┐      ┌─────────┐
        │ claimed │      │ expired │  (terminal; agent restarts at Step 3)
        └────┬────┘      └─────────┘
             │ token endpoint issues jh_live_ key once
             ▼
      credential_issued_at set (further claim-grant polls → invalid_grant)
```

Timers and limits (the exact reference values):

| Timer / limit | Value | Source |
|---|---|---|
| Outer claim window (registration TTL) | **86 400 s (24 h)** | `anonymousTtlSeconds` [REPO agent-services/src/config.ts], applied to service_auth in `createServiceAuthRegistration`; AUTH.md: "the outer claim window — typically 24h" |
| `user_code` TTL | **600 s (10 min)** | `userCodeTtlSeconds` [REPO config]; [DOCS /apps] "≤10 min default" |
| `claim_attempt_token` TTL | **600 s** | `claimViewTokenTtlSeconds` [REPO config] |
| Poll `interval` | **5 s** | `pollIntervalSeconds` [REPO config]; RFC 8628 default |
| `slow_down` penalty | **+≥5 s** | [REPO AUTH.md error table] |
| Wrong-code attempts per code | **5**, then code dead | OUR CHOICE per [PLAN]; spec: "tight per-claim retry limits" unspecified [DOCS /apps] |
| Re-mints per registration | **10** lifetime | OUR CHOICE (no spec value); bounds total code-guess surface per registration |
| Login-link TTL (sessions, §9) | **900 s (15 min)** | [PLAN] — not an auth.md value |
| Session lifetime (§9) | **30 d sliding** | [PLAN] — not an auth.md value |
| Clock skew tolerance | 60 s | `clockSkewSeconds` [REPO config] — only relevant if we later add ID-JAG |

Expiry needs no cron: status is derived on read. The single `registration.expired`
audit event can be emitted lazily, the first time an expired registration is touched.

---

## 5. Security requirements

1. **Hashed at rest, plaintext exactly once** [REPO agent-services/README.md Security
   Considerations; [PLAN]]:
   - `claim_token` (`clm_` + 19 B base64url) — SHA-256 hex stored; plaintext only in
     the registration response.
   - `claim_attempt_token` (`cvt_` + 24 B) — SHA-256 stored; plaintext only inside
     `verification_uri`.
   - `user_code` (6 digits, `crypto.randomInt` CSPRNG — required by
     [DOCS /apps]) — SHA-256 stored; plaintext only in the agent-facing ceremony
     block. **Never emailed** (spec-pure).
   - API key (`jh_live_` + 32 B base64url, ≈43 chars after the prefix) — SHA-256
     stored in `api_keys.token_hash`; first 12 chars stored in `api_keys.prefix` for
     dashboard display; plaintext only in the one token response.
   - Login token (`lt_` + 32 B, §9) — SHA-256 stored; plaintext only inside the
     magic-link URL.
   - Session token (`sess_` + 32 B, §9) — SHA-256 stored; plaintext only in the
     cookie.
2. **Constant-time comparison.** Compare SHA-256 digests with
   `crypto.timingSafeEqual(Buffer, Buffer)` — for the user_code especially (6 digits
   are "guess-bounded only by lockout, not entropy" [DOCS /apps]). The reference
   compares hex strings with `===` [REPO store.ts `completeClaim`]; we harden. Lookups
   by token hash (indexed equality on the digest) are fine — the secret's entropy
   makes timing-based hash recovery a non-issue; the timingSafeEqual requirement is
   for the low-entropy user_code verification.
3. **`WWW-Authenticate` on 401s**: `Bearer resource_metadata="…"` on all resource-API
   401s (§3.5). (The `AgentAuth error="…"` challenge variants exist only on ID-JAG
   paths we don't implement [REPO agent-auth.ts:157–207].)
4. **OAuth cache headers**: `Cache-Control: no-store` + `Pragma: no-cache` on every
   `/oauth2/*` response [REPO token.ts `setOAuthHeaders`].
5. **One credential per registration** (ours, §3.3 step 4) — a long-lived key must
   not be re-mintable by replaying the claim_token.
6. **IP + user-agent capture** at registration, claim re-mint, claim-form submit,
   login-link request, and token issuance, into `audit_log` [DOCS /apps]: "Capture
   IPs at registration, claim, and complete for audit trail."
7. **Email enumeration**: registration always returns the same 200 shape whether or
   not the email already has an account (users are created only at claim confirm —
   nothing to leak). `/login` likewise always says "check your email" (it never
   creates accounts and never reveals whether one exists, §9.2).
8. **CSRF on browser forms** (§9): SameSite=Lax cookie + Origin-header check on
   every mutating POST (`/login`, `/login/verify`, `/claim`) [PLAN].
9. **Session/claim binding**: the claim form only renders—and only accepts—when the
   signed-in session's email matches the registration's email; mismatch is a hard
   reject, not an advisory [REPO claim.ts `hintMismatch` — "Wrong-account is *not*
   an advisory"].
10. **Bulk revocation**: ship `UPDATE api_keys SET revoked_at = now() WHERE user_id = $1
    AND revoked_at IS NULL` as an operator script day one ("Provide an operator-facing
    mechanism to revoke all outstanding agent credentials … for incident response"
    [DOCS /apps]); dashboard surface later.
11. **Secrets never logged.** The auth.md file instructs agents likewise (§2.3,
    pattern from [KERNEL]).
12. **Session isolation from user HTML** [PLAN]: user-uploaded docs render in a
    sandboxed, origin-less iframe — uploaded HTML can never read the session cookie
    or ride a session to the claim form.

---

## 6. Rate limits

### What the sources actually say

The only concrete numbers anywhere in the spec/docs
[REPO agent-services/README.md §Rate Limiting; DOCS /apps verbatim]:

> 1. **Per-IP limit** (checked first). … Sensible default: **5/hour for anonymous,
>    60/hour for identity_assertion**.
> 2. **Per-tenant limit** (checked second). Global cap across IPs. Sensible default:
>    **100/hour anonymous, 1000/hour identity_assertion**.
>
> Use a sliding-window counter backed by a shared store (Redis is common). **Fail
> open on store errors.** If no IP is available …, **skip the per-IP check** rather
> than rejecting.

Plus: user_code needs "tight per-claim retry limits" (no number) [DOCS /apps], the
agent-facing contract reserves `rate_limited` (429) on any endpoint with "back off
and retry" semantics [REPO AUTH.md error table], and `slow_down` for over-eager
polling. There are **no numbers for `service_auth`**, and the magic-link login
surface is entirely ours — those rows below are all OUR CHOICE.

### justhtml.sh limits (concrete)

justhtml.sh is single-tenant, so "per-tenant" becomes a global cap. `service_auth`
is unauthenticated like `anonymous`, so it gets the anonymous-tier IP cap with a
small allowance for typo retries. Email-send cost lives on **every surface that
sends a Resend email keyed to a recipient**: `/login` magic links, the **B9
claim email** (`claim_delivery=email` registration — see §3.1), and share
notifications. These share one set of send caps (rows 11–13, implemented as
`EMAIL_SEND_LIMITS()` so one recipient/IP draws from a single budget regardless
of which surface triggered the send). Note: in B9 email mode, registration
(`POST /agent/identity`) is checked against BOTH the registration caps (rows 1–3)
AND the email-send caps (rows 11–13).

| # | Surface | Key | Limit | Window | Source/rationale |
|---|---------|-----|-------|--------|------------------|
| 1 | `POST /agent/identity` | IP | **10/h** | 1 h | Spec bracket: 5/h anonymous–60/h id-jag [DOCS /apps]; OUR CHOICE 10 = anonymous tier + typo headroom |
| 2 | `POST /agent/identity` | email (lowercased) | **10/h** | 1 h | OUR CHOICE — bounds pending registrations (and code-guess surface) accruing against one address |
| 3 | `POST /agent/identity` | global | **100/h** | 1 h | Spec per-tenant anonymous value [DOCS /apps] |
| 4 | `POST /agent/identity/claim` | registration | **10 re-mints** | lifetime | OUR CHOICE (§4) |
| 5 | `POST /agent/identity/claim` | IP | **30/h** | 1 h | OUR CHOICE |
| 6 | `POST /claim` (form submit) | code | **5 wrong attempts**, then code dead | per code | [PLAN]; spec: "tight" unspecified |
| 7 | `POST /claim` (form submit) | IP | **30/h** | 1 h | OUR CHOICE — backstop against distributed code guessing across registrations |
| 8 | `POST /oauth2/token` (claim grant) | claim_token | **min 5 s between polls** → `slow_down` | rolling | `pollIntervalSeconds` [REPO config]; enforcement we add per README's note |
| 9 | `POST /oauth2/token` | IP | **300/h** | 1 h | OUR CHOICE — a compliant 10-min poll loop is 120 calls; 300 allows 2 concurrent ceremonies + retries |
| 10 | `POST /oauth2/revoke` | IP | **30/h** | 1 h | OUR CHOICE |
| 11 | email send (`/login`, B9 claim email at `/agent/identity`, share notify) | email (lowercased) | **5/h, 20/day** | 1 h / 24 h | OUR CHOICE — inbox bombing + Resend quota. **UNCHANGED** in the 2026-06-12 recalibration. |
| 12 | email send (same surfaces) | IP | **30/h** | 1 h | OUR CHOICE. **Recalibrated 2026-06-12 (10/h → 30/h):** offices/NAT share an IP — during dogfooding our own QA and the human shared one IP and the human got 429'd. 30/h tolerates a shared egress IP while still bounding a single host. |
| 13 | email send (same surfaces) | global | **500/h** | 1 h | OUR CHOICE. **Recalibrated 2026-06-12 (50/h → 500/h):** this cap exists ONLY as a Resend cost / runaway circuit breaker, so it must sit FAR above organic traffic. A global cap at user scale lets one abuser deny login to everyone — "50/hour global is dumb" (founder, 2026-06-12). 500/h is a burn-rate ceiling, not a usage cap. |

Checked in spec order: per-IP first, then per-email, then global [DOCS /apps].
**Fail open** if the counter query errors; **skip the IP check** when no IP is
derivable from `x-forwarded-for` (Vercel always sets it, but per spec, skip — don't
reject) [DOCS /apps].

### Enforcement with PlanetScale Postgres (no Redis)

Fixed 1-hour/1-day windows via an upsert counter — one round trip, atomic. (Spec
suggests sliding windows; at limits this size, fixed windows with the window key in
the row are an acceptable simplification — worst case a burst of 2× at a boundary.)

```sql
CREATE TABLE rate_limits (
  key          text        NOT NULL,  -- e.g. 'ident:ip:203.0.113.7' | 'login:email:raf@kernel.sh' | 'ident:global'
  window_start timestamptz NOT NULL,  -- date_trunc('hour', now()) or day
  count        int         NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

-- one statement per check:
INSERT INTO rate_limits (key, window_start)
VALUES ($1, date_trunc('hour', now()))
ON CONFLICT (key, window_start)
DO UPDATE SET count = rate_limits.count + 1
RETURNING count;  -- compare against the limit in app code
```

- Increment-then-check means rejected requests still consume budget — correct for
  abuse control.
- Limits #6 (`attempts`) and #8 (`last_polled_at`) live as columns on `claim_codes` /
  `agent_registrations` (§10), not in this table — they're per-row state, checked in
  the same `UPDATE … RETURNING` that touches the row anyway. Limit #4 is the
  `remint_count` column.
- GC: `DELETE FROM rate_limits WHERE window_start < now() - interval '48 hours'`
  fired probabilistically (~1% of inserts) — no cron dependency.

### 429 response shape

The agent contract defines `rate_limited` (429) → "Back off and retry"
[REPO AUTH.md error table]. The reference impl never emits one, so the body shape is
ours, matching the envelope of whichever surface tripped:

`/agent/identity*` endpoints:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 1800

{ "error": "rate_limited", "message": "Too many registrations from this address. Retry after 1800 seconds." }
```

`/oauth2/*` endpoints: same status/header, OAuth envelope
`{ "error": "rate_limited", "error_description": "..." }`.

Browser surfaces (`/login`, `/claim`): 429 with `Retry-After` and a man-page-styled
HTML error page ("too many login links requested for this address — try again in
30 minutes").

`Retry-After` = seconds until the window resets (for fixed windows: time to the next
hour/day boundary). Note `slow_down` is **not** a 429 — it's a 400 OAuth error per
§3.3.

---

## 7. Audit events

Baseline set from [REPO agent-services/README.md §Recommended Audit Events] /
[DOCS /apps], minus ID-JAG/SET events we can't emit, plus session events of ours
(marked):

| Event | When | `meta` fields |
|---|---|---|
| `registration.created` | Successful `POST /agent/identity` | `registration_type: "service_auth"`, `login_hint` |
| `user_code.minted` | Code minted (registration + every re-mint) | `claim_code_id` |
| `claim.requested` | `POST /agent/identity/claim` (re-mint) | `email` |
| `claim.attempt_failed` *(ours)* | Wrong user_code at the `/claim` form | `attempts` |
| `claim_email.sent` *(B9)* | Claim email sent (`claim_delivery=email` registration + re-mint) | `claim_code_id`, `resend_id` |
| `claim.confirmed` | Code verified at the `/claim` form OR via the agent read-back (`/agent/identity/claim/complete`) | `claimed_by_user_id`, `session_id` (form) / `via` (`form`\|`complete`) |
| `claim.approved_via_link` *(B9)* | Claim confirmed via the emailed approve link (`POST /claim/approve`) | `claimed_by_user_id`, `session_id`, `via: "approve_link"` |
| `token.issued` | Claim grant returns the API key | `api_key_id`, `scope: "docs.read docs.write"` |
| `token.revoked` | `/oauth2/revoke` flips a live key | `api_key_id` |
| `registration.expired` | First touch of an expired registration (lazy) | — |
| `login_link.requested` *(ours)* | `POST /login` accepted + Resend send | `email`, `resend_id` |
| `session.created` *(ours)* | Magic link verified at `/login/verify` | `email`, `session_id` |
| `rate_limit.tripped` *(ours)* | Any 429 | `key`, `limit` |

Per [DOCS /apps], also tag agent-created resources: `api_keys` rows get
`created_via = 'auth.md'` so the future dashboard doesn't have to join audit events
to know a key is agent-minted ("tag those events with `created_by_agent: true`").

### `audit_log` table

```sql
CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event           text        NOT NULL,             -- 'claim.confirmed' etc.
  registration_id bigint      REFERENCES agent_registrations(id),
  user_id         bigint      REFERENCES users(id),
  api_key_id      bigint      REFERENCES api_keys(id),
  ip              inet,
  user_agent      text,
  meta            jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_registration_idx ON audit_log (registration_id);
CREATE INDEX audit_log_event_time_idx   ON audit_log (event, created_at);
```

Append-only, no updates, no deletes (retention policy can come later). IP/user-agent
captured per [DOCS /apps] security guidance. Never write secrets, codes, or magic
links into `meta` — IDs only.

---

## 8. Deviations from spec (explicit)

**Exactly two deviations remain** [PLAN]. The claim ceremony itself is **spec-pure**:
registration returns the ceremony block, the agent surfaces `user_code` +
`verification_uri` to the human, the human signs in at our service and types the
code into a service-owned form, the agent polls the token endpoint with the claim
grant — precisely the shape in [REPO AUTH.md Step 4] and
[REPO agent-services/src/routes/claim.ts]. (Historical note: an earlier draft of
this spec deviated kernel.sh-style — service-emailed OTP, code read back to the
agent, an agent-callable `claim/complete` endpoint [KERNEL]. Dropped 2026-06-12;
magic-link sign-in (§9) gives the ceremony a real session to bind to, which is what
the spec's design assumes and what stacks cleanly with future policy gates
[DOCS /apps: "The claim ceremony is your primary place to enforce authorization
policies"].)

### 8.1 Long-lived API key instead of access_token + assertion re-exchange — THE deviation

Spec behavior we drop:

- The **service-signed `identity_assertion`** (JWT, `typ: oauth-id-jag+jwt`,
  `sub = registration id`) returned from the claim grant, and its `assertion_expires`
  [REPO AUTH.md §4c; token.ts `handleClaimGrant`].
- The **`urn:ietf:params:oauth:grant-type:jwt-bearer` grant** (RFC 7523) — the
  refresh path where the agent re-exchanges the assertion for a fresh 3600 s
  access_token [REPO config `accessTokenTtlSeconds: 3600`,
  `serviceAssertionTtlSeconds: 3600`; AUTH.md Step 5/6].
- `expires_in` on the token response (our key doesn't expire).
- AS signing keys entirely — with no JWTs to sign, there is no key management
  (the reference keeps a signing key at `.keys/signing-key.json` [REPO config]).

What we keep for compatibility:

- The **token endpoint** and **claim grant** exactly as specified — polling
  semantics, `authorization_pending`/`slow_down`/`expired_token`, form encoding,
  OAuth error envelope, no-store headers.
- The credential is delivered in the standard **`access_token`** field of a standard
  token response and used as a standard **`Authorization: Bearer`** header — an agent
  that ignores our `credential_type` extension and treats it as an opaque bearer
  token works fine; it just never needs to refresh.
- **`/oauth2/revoke`** RFC 7009 semantics, unchanged.
- Discovery shapes, `WWW-Authenticate` 401 bootstrap, hashing rules, claim state
  machine, error vocabulary.

Why: agents store keys in env/config and use them for weeks; an hourly
assertion-re-exchange ceremony makes the product annoying for its primary user
[PLAN]. Precedent: kernel.sh returns a permanent `api_key` as the claim result and
advertises `credential type: api_key` [KERNEL]. Corollary (ours): the key is issued
**exactly once per registration** — the spec lets a claim_token re-poll for fresh
short-lived tokens; with a permanent key that must be locked
(`credential_issued_at`, §3.3 step 4). Consequence we accept: revocation is the only
kill switch (no natural expiry), hence the revoke endpoint, per-user bulk revocation
(§5.10), and `last_used_at` tracking ship in v1.

### 8.2 No anonymous-start

`service_auth` only; reasoning in §1 (pre-claim scopes buy nothing for a docs
product; pre/post-claim key reuse is a hazard the reference README itself flags —
worse with long-lived keys; kernel.sh precedent). The protocol treats this as
capability negotiation, not nonconformance: we advertise
`identity_types_supported: ["service_auth"]` and answer stray `anonymous` /
`identity_assertion` registrations with the spec's own `*_not_enabled` error codes
(§3.1) [REPO AUTH.md Step 2: "send the body and fall back on the `*_not_enabled`
error if the service opted out"].

Likewise capability negotiation rather than deviation: no ID-JAG support and
therefore no `events_endpoint`/RFC 8935 SET receiver, no JWKS fetching, no `jti`
replay cache, no trust list, no step-up ceremony — none are advertised (§2.2). And
we add hard caps where the spec is silent: 5 wrong codes per code, 10 re-mints per
registration, the per-email/per-IP tables in §6.

---

## 9. Sessions & human login

The verification page requires a signed-in session — this is the spec's assumed
shape (`verification_uri` "routes the user through /login first"
[REPO agent-auth.ts `buildVerificationUri`]; the claim form is cookie-gated
[REPO claim.ts `requireUser`]). The reference mocks its IdP; this section specifies
our real one [PLAN "Sessions & human login"]. Everything here is OUR DESIGN — the
auth.md spec intentionally leaves service sign-in to the service.

Principles [PLAN]: DB-backed sessions (no JWT/NextAuth/iron-session), sessions keyed
by **verified email** with `user_id` nullable (the human signs in *before* their
account exists — accounts are created only at claim confirm), sign-up is
**agent-only** (`/login` never creates user accounts), all pages are plain HTML
forms from route handlers, zero JS, man-page styled.

### 9.1 Session model

- Session token: `sess_` + 32 random bytes base64url. SHA-256 at rest
  (`sessions.token_hash`); plaintext lives only in the cookie.
- Cookie: `jh_sess=sess_…; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`.
- Lifetime: **30 days sliding** [PLAN] — on any authenticated request where
  `last_seen_at` is older than 1 hour, set `last_seen_at = now()` and
  `expires_at = now() + 30 days` (the 1 h floor throttles writes).
- Revocation: set `revoked_at`; auth check is one indexed lookup:
  `WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`.
- A session with `user_id IS NULL` is valid — it can confirm claims (and, phase 2,
  comment). The dashboard for account-less sessions says: "no account yet — tell
  your agent to sign up at justhtml.sh/auth.md" [PLAN].
- At claim confirm (§9.3), backfill `user_id` onto the confirming session row so the
  human walks away logged in to their new account.

### 9.2 `/login` — magic-link flow

**`GET /login?next=/claim?claim_attempt_token=...`**
If already signed in → 303 to sanitized `next`. Else render the form: one email
field, hidden `next`, submit button. `next` sanitization (reference's
`sanitizeReturnTo` [REPO agent-services/src/routes/login.ts]): same-origin paths
only — must start with `/`, must not start with `//`; anything else falls back
to `/`.

**`POST /login`** (form: `email`, `next`)

1. Origin-header check (§9.4), then rate limits #11–13 (§6).
2. Validate email shape. **Never create a user row** — sign-up is agent-only [PLAN].
3. Mint a login token: `lt_` + 32 random bytes base64url; store SHA-256 in
   `login_tokens` with `expires_at = now() + 900 s` (15 min [PLAN]); single-use via
   `consumed_at`.
4. Send the magic-link email via Resend (§9.5). Link:
   `https://justhtml.sh/login/verify?token=lt_…&next=%2Fclaim%3F…` (`next` rides the
   URL and is re-sanitized at verify time; the token row stays minimal per [PLAN]).
5. Render 200 "check your email" — same page whether or not the address has an
   account (no enumeration, §5.7).
6. Resend failure → 500 HTML page "couldn't send the email — try again"; the token
   row is rolled back.
7. Audit: `login_link.requested`.

**`GET /login/verify?token=lt_…&next=…`**
Renders a confirmation page with a single button ("sign in as the owner of this
link") that POSTs `token` + `next` back to the same path. The GET **does not**
consume the token — email scanners and link prefetchers fetch GETs and would burn a
single-use token; the consuming step must be a POST. (OUR CHOICE; standard
magic-link hardening.)

**`POST /login/verify`** (form: `token`, `next`)

1. Origin check. Atomic single-use consume:

   ```sql
   UPDATE login_tokens SET consumed_at = now()
   WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
   RETURNING email;
   ```

2. No row → 410 HTML page: "This login link is expired or already used. Request a
   new one at justhtml.sh/login." (One shape for unknown/expired/consumed — no
   distinguishing oracle.)
3. Row → mint session (§9.1), `Set-Cookie`, look up `users` by email to populate
   `user_id` if an account exists, 303 to sanitized `next` (default `/`).
4. Audit: `session.created`.

### 9.3 `/claim` — the hosted claim form (spec's "user-facing claim form")

Semantics mirror the reference's cookie-gated form
[REPO agent-services/src/routes/claim.ts], minus the mock IdP.

**`GET /claim?claim_attempt_token=cvt_…`**

| Condition (checked in order) | Status | Page |
|---|---|---|
| No valid session | 303 | Redirect to `/login?next=%2Fclaim%3Fclaim_attempt_token%3D…` [REPO claim.ts `requireUser`] |
| Token unknown / superseded by a re-mint | 404 | "Link invalid — it may have been superseded, used, or expired. Ask the agent to start a new claim." [REPO claim.ts] |
| Registration already claimed | 200 | "Already claimed. You can close this tab." |
| Attempt expired (`view_expires_at` passed) | 410 | "Link expired. Ask the agent for a fresh code and link." |
| Session email ≠ registration email | 403 | "This claim was started for `ali…@co.com`. You're signed in as `bob@x.com`. Sign in as that address to authorize the agent." + link to `/login?next=…` [REPO claim.ts `renderWrongAccount` — hard reject, not advisory] |
| OK | 200 | The form |

The form page shows: "You're signed in as `raf@kernel.sh`. The agent should have
shown you a 6-digit code — enter it below to authorize it to act on your behalf."
Input: `name="user_code"`, `inputmode="numeric"`, `pattern="[0-9]{6}"`,
`autocomplete="one-time-code"`. Hidden field: `claim_attempt_token`. Below the
button, the reference's warning copy verbatim [REPO claim.ts:351]: "Only enter a
code from an agent you trust. Pasting a code from an untrusted source could let
that agent act on your behalf." First-agent advisory ("This is the first agent
being linked to `raf@kernel.sh`") when the email has no prior claimed registration
[REPO claim.ts `computeAdvisories`].

**`POST /claim`** (form: `claim_attempt_token`, `user_code`)

1. Origin check; session required (same 303-to-login on missing session); rate
   limits #6–7 (§6).
2. Re-resolve the registration by `sha256(claim_attempt_token)`; re-check email
   match (same-account check applies again on submit [DOCS /apps]).
3. Verify the code: increment-then-compare in one statement —
   `UPDATE claim_codes SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS
   NULL RETURNING attempts, code_hash, expires_at` — then `timingSafeEqual` on the
   hash (§5.2).
4. Outcomes (statuses per the reference's `statusForError`
   [REPO claim.ts:285–297]; copy per its `humanError`):

| Outcome | Status | Page |
|---|---|---|
| Wrong code, attempts < 5 | 401 | Form re-rendered with: "That code doesn't match. Check the digits and try again." + "N attempts remaining." (count is OUR ADDITION) |
| Wrong code, attempt 5 | 410 | Mark code `consumed_at`; "Too many incorrect attempts — this code is dead. Ask the agent for a fresh code." (mapping is OUR CHOICE, §3.3) |
| Code expired | 410 | "That code has expired. Ask the agent for a fresh code." |
| Registration claimed already | 409 | "This registration has already been claimed." |
| Registration expired | 410 | "This claim has expired. Ask the agent to start a new one." |
| Success | 200 | "All set — the agent has been authorized to act on your behalf. You can close this tab; the agent will pick up automatically." [REPO claim.ts "done" copy] |

5. On success, in one transaction: set `claim_codes.consumed_at`;
   **find-or-create the `users` row** for the registration email (this is account
   creation — the only place it happens); set `agent_registrations.user_id` +
   `claimed_at`; backfill `sessions.user_id` (§9.1). The claim handle stays resolvable
   by `claim_token` so the agent's poll completes
   [REPO store.ts `completeClaim` comment].
6. Audit: `claim.confirmed` or `claim.attempt_failed`.

### 9.3.1 `/claim/approve` — the emailed approve link (B9, email mode)

> **NEW (B9 hybrid claim).** In `claim_delivery=email` mode the claim email
> carries a scanner-safe one-click approve link, `GET|POST /claim/approve?token=cva_…`.
> Same GET-confirm / POST-consume shape as `/login/verify`: the GET renders a
> man-page confirm page ("Approve the API key for `raf@…`? [approve]") and does
> NOT consume the token (email scanners/prefetchers fetch GETs); the POST
> consumes it (single-use, hashed at rest in `claim_codes.approve_token_hash`).
> The approve token is **per-attempt** (TTL = the user_code TTL, 600 s; tied to
> the specific live attempt — a re-mint supersedes it and emails a fresh one).
> Unlike `/claim`, this surface needs **no pre-existing session**: inbox
> possession IS the binding proof, so approving mints a fresh session for the
> registration email (the human walks away logged in) AND confirms the claim,
> then 303s to `/docs`. Audit: `claim.approved_via_link`. The approve link and
> the read-back (§3.2.1) share the one live attempt row, so whichever fires
> first consumes it.

### 9.4 CSRF & form transport

- The browser POST surfaces (`/login`, `/login/verify`, `/claim`, and the B9
  `/claim/approve`) are protected by **SameSite=Lax + Origin check** [PLAN]: if
  an `Origin` header is present and is not `https://justhtml.sh`, reject 403.
  (Lax already blocks cross-site POSTs with cookies; the Origin check is the
  second factor. No token-based CSRF needed — the forms are stateless HTML.)
- All pages are served from route handlers as handwritten HTML (man-page style,
  monospace, no JS) [PLAN] — same technique as the homepage.

### 9.5 The login email

> **NOTE (B9):** "the only email" is no longer accurate. justhtml.sh now sends
> three handwritten man-page emails: this login magic link, the share
> notification (birthday.md "Share notifications"), and the **B9 claim email**
> (`claim_delivery=email` registration — subject `your agent wants a justhtml.sh
> API key`, carries the approve link + the 6-digit code). All share the sender
> below, the man-page style, and the §6 rows 11–13 send caps.

**Sender**: `justhtml.sh <login@notify.justhtml.sh>` — dedicated sending subdomain
so transactional reputation is isolated from the root domain. DONE 2026-06-12:
`notify.justhtml.sh` is verified in Resend and the API key is in `.env`
(`RESEND_API_KEY`). Set DMARC on the root. DNS lives in Kernel's Vercel
account (the domain is already purchased there [PLAN]). No reply-to.

**Subject**: `justhtml.sh login` [PLAN — exact string].

**Body**: handwritten plain HTML, man-page style — monospace, no images, no tracking
pixels, no template framework [PLAN: "The email IS the brand"]. Inline styles only
(email clients strip `<style>`); a `text/plain` part with the same content.

```html
<!doctype html>
<html>
  <body style="margin:0; padding:24px; background:#ffffff;">
    <pre style="margin:0; font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace; font-size:13px; line-height:1.5; color:#111111; white-space:pre-wrap;">
JUSTHTML.SH(1)                     LOGIN                     JUSTHTML.SH(1)

NAME
    justhtml.sh login link

SYNOPSIS
    you (or your agent's claim ceremony) asked to sign in as
    raf@kernel.sh

LINK
    <a href="https://justhtml.sh/login/verify?token=lt_...&amp;next=%2Fclaim%3Fclaim_attempt_token%3D..." style="color:#0000ee;">https://justhtml.sh/login/verify?token=lt_...</a>

NOTES
    single use. expires in 15 minutes.

    clicking signs you in on this device. if a claim ceremony is in
    progress you'll land on the code form — type the 6-digit code
    your agent showed you.

    didn't request this? ignore it. nothing happens without the
    click, and this link creates no account by itself.

JUSTHTML.SH                      2026-06-12                  JUSTHTML.SH(1)
    </pre>
  </body>
</html>
```

Notes:

- The 15-minute expiry in the copy must match `login_tokens.expires_at` — source
  both from the same config constant.
- The link target is the **confirmation page** (`GET /login/verify`), not a
  direct-consume URL — scanner-safe (§9.2).
- Resend tags: `{ name: "flow", value: "login_link" }`; store the Resend message id
  in the `login_link.requested` audit event (§7).
- This replaces the OTP email from the earlier draft of this spec — **no claim-code
  email exists**; the `user_code` reaches the human only via the agent (spec-pure).

---

## 10. Mapping onto the planned DB tables

[PLAN] tables (revised 2026-06-12) align with the reference impl's store model
[REPO agent-services/src/store.ts]. Full DDL with the columns the [PLAN] summary
omits:

### `users` — unchanged

`id, email citext UNIQUE, created_at`. Created **only at claim confirm** (§9.3) —
never at registration, never at `/login` [PLAN].

### `agent_registrations`

```sql
CREATE TABLE agent_registrations (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id            text NOT NULL UNIQUE,         -- 'reg_' + 16B base64url (wire id, [REPO store.ts])
  type                 text NOT NULL DEFAULT 'service_auth'
                         CHECK (type = 'service_auth'),  -- no anonymous-start [PLAN]
  email                citext NOT NULL,              -- the login_hint; updatable by re-mint (§3.2)
  user_id              bigint REFERENCES users(id),  -- NULL until claimed
  claim_token_hash     text NOT NULL UNIQUE,         -- sha256 hex of clm_…
  claim_expires_at     timestamptz NOT NULL,         -- created_at + 24h
  claimed_at           timestamptz,
  credential_issued_at timestamptz,                  -- long-lived key issued exactly once (§3.3)
  last_polled_at       timestamptz,                  -- slow_down enforcement (§6 #8)
  remint_count         int NOT NULL DEFAULT 0,       -- cap 10 (§6 #4)
  created_at           timestamptz NOT NULL DEFAULT now()
);
```

**No `status` column** — derived (`claimed_at IS NOT NULL` → claimed;
`claim_expires_at < now()` → expired; else pending) exactly as the reference's
getter: "no separate status column to keep in sync, no sweeper job needed"
[REPO store.ts `Registration.status` comment]; adopted by [PLAN].

### `claim_codes` (renamed from the earlier draft's `auth_codes`)

This table *is* the spec's claim attempt
[REPO store.ts `RegistrationClaimAttempt`]. [PLAN] summary lists
`registration_id, code_hash, expires_at (10 min), attempts (max 5), consumed_at`;
the implementation additionally needs the `claim_attempt_token` columns (the
`cvt_` token that makes `verification_uri` unguessable and lets a re-mint kill the
old link) and bookkeeping:

```sql
CREATE TABLE claim_codes (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id         text NOT NULL UNIQUE,            -- 'cla_' + 16B base64url (claim_attempt_id on the wire)
  registration_id   bigint NOT NULL REFERENCES agent_registrations(id),
  code_hash         text NOT NULL,                   -- sha256 of 6-digit user_code
  view_token_hash   text NOT NULL UNIQUE,            -- sha256 of cvt_… (claim_attempt_token)
  expires_at        timestamptz NOT NULL,            -- code TTL: +600s
  view_expires_at   timestamptz NOT NULL,            -- attempt-token TTL: +600s
  attempts          int NOT NULL DEFAULT 0,          -- dead at 5
  consumed_at       timestamptz,                     -- set on success OR attempts-exhausted
  superseded_at     timestamptz,                     -- set when a re-mint replaces this attempt
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX claim_codes_one_live_attempt
  ON claim_codes (registration_id)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
```

The partial unique index enforces the reference's invariant that a registration has
exactly one current attempt (re-mint replaces wholesale
[REPO store.ts `recordClaimAttempt`]) while keeping dead attempts as audit history.
No per-attempt email column: the binding email lives on `agent_registrations.email`
(a corrected re-mint updates it there, §3.2).

### `login_tokens` (new — §9.2)

```sql
CREATE TABLE login_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       citext NOT NULL,
  token_hash  text NOT NULL UNIQUE,                  -- sha256 of lt_…
  expires_at  timestamptz NOT NULL,                  -- created_at + 15 min
  consumed_at timestamptz,                           -- single-use
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

### `sessions` (new — §9.1)

```sql
CREATE TABLE sessions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        citext NOT NULL,                      -- sessions keyed by verified email
  user_id      bigint REFERENCES users(id),          -- nullable: accounts exist only after a claim
  token_hash   text NOT NULL UNIQUE,                 -- sha256 of sess_…
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,                 -- 30 d sliding
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
```

### `api_keys`

```sql
CREATE TABLE api_keys (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES users(id),
  registration_id bigint REFERENCES agent_registrations(id),
  token_hash      text NOT NULL UNIQUE,             -- sha256 of full jh_live_… key
  prefix          text NOT NULL,                    -- first 12 chars for display
  scopes          text[] NOT NULL DEFAULT '{docs.read,docs.write}',
  created_via     text NOT NULL DEFAULT 'auth.md',  -- 'created_by_agent' tagging [DOCS /apps]
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
```

Auth middleware: hash the presented bearer, single indexed lookup on `token_hash`
`WHERE revoked_at IS NULL`, bump `last_used_at` (throttled to ~1/min per key to
avoid a write per request).

### New tables

`rate_limits` (§6) and `audit_log` (§7).

---

## 11. Build checklist (auth slice only)

1. Migrations: tables above (§10, §6, §7).
2. `lib/auth/` module: token minting (`reg_`/`clm_`/`cvt_`/`lt_`/`sess_`/`jh_live_`
   + `sha256Hex` + `timingSafeEqual` compare), config constants
   (`CLAIM_WINDOW_S=86400`, `USER_CODE_TTL_S=600`, `ATTEMPT_TOKEN_TTL_S=600`,
   `POLL_INTERVAL_S=5`, `MAX_CODE_ATTEMPTS=5`, `MAX_REMINTS=10`,
   `LOGIN_TOKEN_TTL_S=900`, `SESSION_TTL_S=2592000`), rate-limit helper, session
   helper (cookie read → indexed lookup → sliding bump).
3. Agent-facing route handlers per §3; discovery + auth.md per §2.
4. Browser surfaces per §9: `/login`, `/login/verify`, `/claim` — plain-HTML
   man-page-styled forms, Origin checks.
5. Resend client + the login-link email per §9.5 (sending domain
   `notify.justhtml.sh` already verified in Resend, key in `.env`).
6. Bearer middleware with `WWW-Authenticate` per §3.5, wired into `/api/v1/*`.
7. Acceptance test = the [PLAN] one: fresh agent pointed at `justhtml.sh/auth.md`
   registers; the only human steps are *click the login link in the email* and
   *type the code the agent showed*; agent ends holding a working `jh_live_` key
   and the human ends up logged in. Plus: wrong code ×5 → dead code → agent re-mint
   → success; session email ≠ registration email → 403 wrong-account page;
   poll-too-fast → `slow_down`; second poll after issuance → `invalid_grant`;
   25 h-old registration → `expired_token`; reused/expired magic link → 410.
```
