// GET /llms.txt — terse, agent-facing usage doc. Plain text. Zero JS.
//
// Served as a route handler (new Response(text)) per the brand rule: every
// surface that can be plain text/HTML IS, off a handler. Mirrors the same
// technique as /auth.md and /api/spec.yaml. force-dynamic keeps it a real
// handler response (see note in app/route.ts on why we avoid force-static).
export const dynamic = "force-dynamic";

const BODY = `# justhtml.sh

> An agent-first minimal HTML document host. Your agent self-onboards, gets a
> long-lived API key, and publishes HTML to stable URLs like
> https://justhtml.sh/d/fierce-tiger-12345. Docs are private by default,
> shareable via a view token, and optionally public. Humans and their agents
> collaborate on the same documents.

Everything here is reachable with curl. No SDK required. JSON in, JSON out;
Authorization: Bearer jh_live_... on the API.

## Authentication

Full prose protocol (auth.md service_auth flow): https://justhtml.sh/auth.md
Machine-readable discovery:
  https://justhtml.sh/.well-known/oauth-protected-resource
  https://justhtml.sh/.well-known/oauth-authorization-server

Short version: you can't self-issue a key. Register with the human's email.
By default (claim_delivery=email) we email the human a 6-digit code AND a
one-click approve link — they just check their inbox: click approve, or read
the code back to you. Either way you poll for the key. Steps:

  # 1. Start registration (no account is created yet). Default delivery=email.
  curl -s https://justhtml.sh/agent/identity \\
    -H 'Content-Type: application/json' \\
    -d '{"type":"service_auth","login_hint":"you@example.com"}'
  # -> { claim_token, claim: { delivery:"email", complete_url, expires_in,
  #      interval } }   # NOTE: user_code is NOT returned in email mode.

  # 2. Tell the human: "check your email for a justhtml.sh message — click
  #    approve, or tell me the 6-digit code." Then EITHER:
  #    (a) they click approve in the email (one click confirms + signs them in
  #        — you do nothing), OR
  #    (b) they read the code back to you; submit it:
  curl -s https://justhtml.sh/agent/identity/claim/complete \\
    -H 'Content-Type: application/json' \\
    -d '{"claim_token":"clm_...","user_code":"428117"}'
  #    -> 200 {status:"claimed"}; wrong code -> 401 (5 tries, then 410 code_dead)

  # 3. Poll for the credential (every claim.interval = 5s). Form-encoded.
  curl -s https://justhtml.sh/oauth2/token \\
    -d grant_type=urn:workos:agent-auth:grant-type:claim \\
    -d claim_token=clm_...
  # -> authorization_pending until they finish; then { access_token: "jh_live_..." }

  # Code expired before they acted? Re-mint (24h registration window) — sends a
  # fresh email (new code + approve link), invalidates the old one:
  curl -s https://justhtml.sh/agent/identity/claim \\
    -H 'Content-Type: application/json' \\
    -d '{"claim_token":"clm_...","email":"you@example.com"}'

  # SPEC-PURE variant: register with "claim_delivery":"agent" to get the
  # user_code + verification_uri in the response (nothing emailed) and surface
  # them to the human yourself; they enter the code at the hosted form. No
  # /claim/complete in that mode. See https://justhtml.sh/auth.md for both.

  # Revoke a key (RFC 7009, idempotent):
  curl -s https://justhtml.sh/oauth2/revoke -d token=jh_live_...

Store the key in a secret store or ~/.justhtml/credentials (mode 0600). Never
print it in logs, chat, commits, or tool output. On any 401, discard the key
and restart discovery from /auth.md. 401s carry a WWW-Authenticate header
pointing back at the discovery metadata.

Scopes: docs.read docs.write (every key carries both).

## API (base: https://justhtml.sh/api/v1)

All requests: Authorization: Bearer jh_live_...
Errors are JSON: { "error": "...", "message": "..." } with the documented
status. OpenAPI 3.1: https://justhtml.sh/api/spec.yaml

Create a doc -> POST /docs   { html, title?, public? }
  curl -s https://justhtml.sh/api/v1/docs -H "Authorization: Bearer $JUSTHTML_API_KEY" \\
    -H 'Content-Type: application/json' \\
    -d '{"html":"<h1>Hi</h1>","title":"Demo","public":false}'
  # -> 201 { slug, url, view_token, version, public, ... }
  # Private doc share link: <url>?viewtoken=<view_token>

List docs -> GET /docs?scope=owned|shared|all&limit=100
  curl -s https://justhtml.sh/api/v1/docs -H "Authorization: Bearer $JUSTHTML_API_KEY"
  # scope=owned (default): docs you own. scope=shared: docs granted to your
  # email or your email's domain (excludes docs you own). scope=all: both.
  # Each item: { slug, url, title, access, version, public, created_at,
  #              updated_at }. access is owner|editor|commenter|viewer (an
  #              explicit email grant beats a domain grant). Owned items also
  #              carry view_token; shared items do not.
  curl -s 'https://justhtml.sh/api/v1/docs?scope=all' -H "Authorization: Bearer $JUSTHTML_API_KEY"
  # The signed-in web equivalent (owned + shared sections) is https://justhtml.sh/docs

Fetch one (metadata + html) -> GET /docs/:slug
  curl -s https://justhtml.sh/api/v1/docs/fierce-tiger-12345 -H "Authorization: Bearer $JUSTHTML_API_KEY"

Update (full rewrite / title / visibility) -> PATCH /docs/:slug   { html?, title?, public? }
  curl -s -X PATCH https://justhtml.sh/api/v1/docs/fierce-tiger-12345 \\
    -H "Authorization: Bearer $JUSTHTML_API_KEY" -H 'Content-Type: application/json' \\
    -d '{"public":true}'

Patch (deterministic edits) -> POST /docs/:slug/edits   { edits:[{oldText,newText}], base_version? }
  curl -s https://justhtml.sh/api/v1/docs/fierce-tiger-12345/edits \\
    -H "Authorization: Bearer $JUSTHTML_API_KEY" -H 'Content-Type: application/json' \\
    -d '{"edits":[{"oldText":"<h1>Hi</h1>","newText":"<h1>Hello</h1>"}],"base_version":1}'
  # Always send base_version. Mismatch -> 409 with current_version. Ambiguous /
  # no-match / overlapping edits -> 422 naming the failing edit (retry with more
  # context).

Delete (soft) -> DELETE /docs/:slug
  curl -s -X DELETE https://justhtml.sh/api/v1/docs/fierce-tiger-12345 -H "Authorization: Bearer $JUSTHTML_API_KEY"

Rotate view token (the "un-share" action) -> POST /docs/:slug/rotate-token
  curl -s -X POST https://justhtml.sh/api/v1/docs/fierce-tiger-12345/rotate-token -H "Authorization: Bearer $JUSTHTML_API_KEY"

Version history -> GET /docs/:slug/versions   and   GET /docs/:slug/versions/:n
  curl -s https://justhtml.sh/api/v1/docs/fierce-tiger-12345/versions -H "Authorization: Bearer $JUSTHTML_API_KEY"

Share (owner only) -> POST /docs/:slug/grants   { email|domain, role, notify? }   role: editor|commenter|viewer
  curl -s https://justhtml.sh/api/v1/docs/fierce-tiger-12345/grants \\
    -H "Authorization: Bearer $JUSTHTML_API_KEY" -H 'Content-Type: application/json' \\
    -d '{"email":"teammate@co.com","role":"editor"}'
  # -> 201 { slug, grant, notified: true }   (notified present only for email grants)
  # Domain grants (e.g. {"domain":"co.com"}) work too; consumer providers
  # (gmail.com, ...) are rejected -> use public or the view token instead.
  # A teammate's agent registers via auth.md with that email and the grant
  # authorizes their edits.
  #
  # Email grants send the grantee a share-notification email with ONE link that
  # logs them in (no account needed) and lands them on /d/:slug — a 7-day,
  # single-use login link. The email also tells them how to register an agent
  # via auth.md to edit. Pass {"notify":false} to suppress the email (e.g. you'll
  # share the link yourself). Domain grants NEVER email (we don't notify a whole
  # company). Notification sends count against the per-recipient email caps.

List / revoke grants -> GET /docs/:slug/grants ; DELETE /docs/:slug/grants/:id

## Comments & reactions

Humans and agents comment on the same documents. A human click-drags to
highlight; an agent "highlights" by QUOTING the text it wants to comment on.
Same payload, same endpoint. Identity is required to write (your API key, or a
signed-in session) — anonymous viewers can read comments but never write.

An anchor is a W3C text-quote selector:
  { "exact": "the verbatim passage", "prefix": "~32 chars before",
    "suffix": "~32 chars after" }   # prefix/suffix disambiguate repeats
Omit "anchor" (or send null) for a DOC-LEVEL comment. "parent_id" makes a reply
(1-level threads only). Re-anchoring runs in the same transaction as every doc
edit: a comment whose quoted text survives moves with it; if the text is gone or
ambiguous the comment is marked "orphaned" (kept, shown unanchored) — and
un-orphaned automatically if a later edit restores the text.

Comment on a quote -> POST /docs/:slug/comments   { body, anchor?, parent_id? }
  curl -s https://justhtml.sh/api/v1/docs/fierce-tiger-12345/comments \\
    -H "Authorization: Bearer $JUSTHTML_API_KEY" -H 'Content-Type: application/json' \\
    -d '{"body":"name the retention cap here?","anchor":{"exact":"full snapshot rather than a diff","prefix":"Each segment retains a ","suffix":", which makes"}}'
  # -> 201 { comment: { id, author, body, anchor, orphaned, resolved, ... } }

See the WHOLE picture (what humans see) -> GET /docs/:slug/comments
  curl -s https://justhtml.sh/api/v1/docs/fierce-tiger-12345/comments \\
    -H "Authorization: Bearer $JUSTHTML_API_KEY"
  # -> { total, can_comment, can_react, threads:[ { id, author, body, anchor,
  #      group:"anchored"|"doc"|"orphaned", resolved, orphaned, reactions:[...],
  #      replies:[...] } ] }   # anchored threads in document order, then
  #      doc-level, then orphaned. Resolved threads carry resolved:true.

Reply / edit / resolve / delete -> PATCH|DELETE /docs/:slug/comments/:id
  # Reply: POST /comments with {"body":"+1","parent_id": <root id>}
  # Edit body (author only): PATCH /comments/:id {"body":"..."}
  # Resolve/unresolve (anyone who can comment): PATCH /comments/:id {"resolved":true}
  # Delete (author own, owner any; soft): DELETE /comments/:id

React (attributed; re-post toggles off) -> POST /docs/:slug/reactions   { emoji, comment_id? }
  curl -s https://justhtml.sh/api/v1/docs/fierce-tiger-12345/reactions \\
    -H "Authorization: Bearer $JUSTHTML_API_KEY" -H 'Content-Type: application/json' \\
    -d '{"emoji":"👍","comment_id":42}'   # omit comment_id to react on the doc
  # Remove a reaction: DELETE /docs/:slug/reactions/:id (your own), or re-POST to toggle.

Who can comment: the owner, an editor or commenter grant, a view-token holder
WITH identity, or any identity on a public doc. Who can react: anyone who can
view, with identity. Private-doc commenting from a session also works for
grantees who signed in (no token needed).

## Viewing

  https://justhtml.sh/d/:slug                 viewer shell (chrome + sandboxed iframe)
  https://justhtml.sh/d/:slug/raw             zero-chrome HTML (CSP sandbox)
  https://justhtml.sh/d/:slug?viewtoken=...   private docs, via the view token
  https://justhtml.sh/docs                    signed-in listing: owned + shared docs

A private doc authorizes a viewer in order: owner session, then a session whose
email matches an email/domain grant, then a matching ?viewtoken=, then public.
So a human you granted by email can also just sign in (no token, no account) and
view it — that's what the share-notification email link does. If a share link
expired, the private-doc page offers "Was this shared with you? Sign in"
(-> /login?next=/d/:slug), which recovers access in one email round-trip.

## Limits

Resource quotas (per user):
  Max HTML size per doc       2 MB        request rejected 413 payload_too_large
  Docs per user               500         soft-deleted don't count; 403 quota_exceeded
  Versions retained per doc   100         oldest snapshots pruned beyond this
  Total storage per user      100 MB      current html + retained snapshots; 403
  Grants per doc              50          403 quota_exceeded
  Comment body size           10 KB       413 payload_too_large
  Comments per doc            1,000       403 quota_exceeded
  API keys per user           10

API rate limits (per API key) -> 429 with Retry-After + { error: "rate_limited" }:
  Doc creates                 60 / hour
  Writes (PATCH,/edits,grants,rotate)  60 / min
  Reads (GET)                 300 / min

Unauthenticated viewer routes (per IP):  300 / min

Auth-flow limits (per IP / per email) protect registration, code attempts (max
5 wrong attempts per code, shared across the approve link / read-back / hosted
form), and email sends (login links + claim emails: 5/h + 20/day per recipient,
30/h per IP). See /auth.md.
`;

export function GET() {
  return new Response(BODY, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
