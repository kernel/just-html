// Canonical agent-facing usage content — the SINGLE source of truth shared by:
//   - GET /llms.txt              (app/llms.txt/route.ts serves LLMS_BODY)
//   - skills/just-html/SKILL.md  (scripts/gen-skill.ts writes frontmatter + LLMS_BODY)
//
// Edit the content HERE; run `npm run gen:skill` (runs via tsx) — or let the
// skill-sync GitHub Action do it — to regenerate the committed SKILL.md that
// `npx skills add kernel/just-html` reads.

export const SKILL_NAME = "just-html";

export const SKILL_DESCRIPTION =
  "Publish, edit, and collaborate on HTML documents at justhtml.sh. Covers agent self-onboarding (the auth.md emailed-code flow to get an API key) and the full doc / comment / reaction API with curl examples. Use when asked to publish or host an HTML document, spec, doc, outline, or proposal; to share one with a person or their agent; or to comment on / edit a justhtml.sh document.";

export const LLMS_BODY = `# justhtml.sh

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

Short version: you can't self-issue a key. There is exactly ONE flow. Register
with the human's email; we email them a 6-digit code; they read it back to you;
you submit it and poll for the key. Steps:

  # 1. Start registration (no account is created yet). We email the human a
  #    6-digit code. The user_code is NOT in the response.
  curl -s https://justhtml.sh/agent/identity \\
    -H 'Content-Type: application/json' \\
    -d '{"type":"service_auth","login_hint":"you@example.com"}'
  # -> { claim_token, claim: { complete_url, expires_in, interval } }

  # 2. Tell the human: "check your email and tell me the 6-digit code from the
  #    justhtml.sh message." When they give it to you, submit it:
  curl -s https://justhtml.sh/agent/identity/claim/complete \\
    -H 'Content-Type: application/json' \\
    -d '{"claim_token":"clm_...","user_code":"428117"}'
  #    -> 200 {status:"claimed"}; wrong code -> 401 (5 tries, then 410 code_dead)

  # 3. Poll for the credential (every claim.interval = 5s). Form-encoded.
  curl -s https://justhtml.sh/oauth2/token \\
    -d grant_type=urn:workos:agent-auth:grant-type:claim \\
    -d claim_token=clm_...
  # -> authorization_pending until they finish; then { access_token: "jh_live_..." }

  # Code expired before they read it back? Re-mint (24h registration window) —
  # emails a fresh code and invalidates the old one:
  curl -s https://justhtml.sh/agent/identity/claim \\
    -H 'Content-Type: application/json' \\
    -d '{"claim_token":"clm_...","email":"you@example.com"}'

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
  # Each item: { slug, url, title, access, version, public, comment_count,
  #              created_at, updated_at }. access is owner|editor|commenter|
  #              viewer (an explicit email grant beats a domain grant).
  #              comment_count is live comments+replies on the doc. Owned items
  #              also carry view_token; shared items do not.
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

React (attributed; re-post toggles off) -> POST /docs/:slug/reactions   { emoji, comment_id?, anchor? }
  # A reaction targets exactly ONE of: a comment (comment_id), a text span
  # (anchor — same W3C shape as a comment anchor), or the whole doc (neither).
  # React on the doc:
  curl -s https://justhtml.sh/api/v1/docs/fierce-tiger-12345/reactions \\
    -H "Authorization: Bearer $JUSTHTML_API_KEY" -H 'Content-Type: application/json' \\
    -d '{"emoji":"👍"}'                                  # doc-level (no target)
  # React on a comment: add {"comment_id":42}.
  # React on a QUOTED SPAN (anchored reaction — an agent "highlights" by quoting):
  curl -s https://justhtml.sh/api/v1/docs/fierce-tiger-12345/reactions \\
    -H "Authorization: Bearer $JUSTHTML_API_KEY" -H 'Content-Type: application/json' \\
    -d '{"emoji":"🚀","anchor":{"exact":"deterministic compaction","prefix":"record store with ","suffix":"."}}'
  # -> 201 { reaction: { id, emoji, author, comment_id, anchor, anchored_version,
  #          orphaned, created_at } }
  #    (or 200 { toggled:true, removed:true } if the same reaction existed)
  # Supplying BOTH comment_id AND anchor is a 400 (the target is mutually exclusive).
  # Remove a reaction: DELETE /docs/:slug/reactions/:id (your own), or re-POST to toggle.
  # Reactions are unique per (target, author, emoji) — for spans, "target" is the
  # anchor signature, so the SAME emoji on two different spans are two reactions.
  # Anchored reactions re-anchor on every doc edit exactly like comments (move,
  # or orphan + un-orphan); an orphaned anchored reaction degrades to doc-level.
  # Allowed emoji are a curated set: 👍 👎 🎉 🤔 ❤️ 🚀 👀 😄 🙏 🔥 ✅ 💯 — anything
  # else 400s with {"error":"invalid_request","allowed":[…]}.
  # GET /comments returns each comment's reactions, any doc-level reactions as a
  # top-level "doc_reactions":[{emoji,count,authors}], and span reactions as
  # "anchored_reactions":[{sig, anchor, reactions:[{emoji,count,authors}]}] grouped
  # by span in document order (present only when any exist).

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
5 wrong attempts per code), and email sends (login links + claim codes: 5/h +
20/day per recipient, 30/h per IP). See /auth.md.
`;
