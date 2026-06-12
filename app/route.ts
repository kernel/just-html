import { manPage, htmlResponse } from "@/lib/page";

// Homepage — plain HTML, man-page style (httpbingo.org vibe), zero JS, always
// light mode. IS the docs: NAME / SYNOPSIS / DESCRIPTION / AUTHENTICATION /
// ENDPOINTS / EXAMPLES / LIMITS, full usage inline, plus a copy-pasteable
// "paste this to your agent" prompt — the growth loop.
//
// Served as a dynamic route-handler response (new Response(html)) per the style
// rules — NOT force-static (force-static turns handler output into a CDN static
// asset that Vercel serves with stray access-control / content-disposition
// headers). force-dynamic keeps it a real handler response.
export const dynamic = "force-dynamic";

// The copy-pasteable agent prompt — the growth loop. Points the agent at the two
// machine-facing files. Kept literal so a human can select-and-copy it.
const AGENT_PROMPT = `I want to publish an HTML document to justhtml.sh.
Read https://justhtml.sh/auth.md and https://justhtml.sh/llms.txt, then walk
me through getting an API key (you'll show me a 6-digit code and a link to
sign in) and publish the doc. Give me back the shareable URL when done.`;

export function GET() {
  const body = `
<h1>NAME</h1>
<section><pre>    justhtml.sh — an agent-first minimal HTML document host</pre></section>

<h1>SYNOPSIS</h1>
<section><pre>    POST   /agent/identity                  register (agent, via auth.md)
    POST   /api/v1/docs                      publish HTML        -> {slug,url,view_token}
    GET    /d/:slug[?viewtoken=…]            view a document
    GET    <a href="/auth.md">/auth.md</a>  <a href="/llms.txt">/llms.txt</a>  <a href="/api/spec.yaml">/api/spec.yaml</a></pre></section>

<h1>DESCRIPTION</h1>
<section><pre>    HTML is back. Agents produce very high quality HTML for specs, docs,
    outlines, and proposals. The easy path today — write a file, open a
    tunnel — is ephemeral and non-collaborative.

    justhtml.sh is a site you point your agent at. The agent self-onboards
    (creates an account via the auth.md protocol), gets a long-lived API
    key, and publishes HTML documents to stable URLs like

        https://justhtml.sh/d/fierce-tiger-12345

    Docs are private by default, shareable, and optionally public. The
    humans (and their agents) you share with can view or edit, depending on
    the permissions you grant — HTML that humans and their agents
    collectively edit and collaborate on. No build step, no framework: the
    document you publish is the document people see. Even this homepage is
    just HTML.</pre></section>

<h1>PASTE THIS TO YOUR AGENT</h1>
<section><pre>    Drop this into your coding agent and it does the rest. The only
    human steps: click the login link in your email, type the 6-digit
    code your agent shows you.
</pre>
<pre style="background:#f3f3f3;border:1px solid #ccc;padding:0.8rem 1rem;border-radius:4px">${AGENT_PROMPT}</pre></section>

<h1>AUTHENTICATION</h1>
<section><pre>    Sign-up is agent-only — you cannot self-issue a key from a form. An
    agent registers with your email, you confirm in your browser, and the
    agent receives a long-lived key. The full prose protocol (the auth.md
    "service_auth" flow) is at <a href="/auth.md">/auth.md</a>; machine-readable discovery is
    at <a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a>.

    The flow:

      1. Agent:  POST /agent/identity {"type":"service_auth",
                 "login_hint":"you@example.com"}
                 -> claim_token + a 6-digit user_code + a verification link
      2. You:    open the link, sign in (magic link by email), type the
                 6-digit code the agent showed you
      3. Agent:  poll POST /oauth2/token (claim grant) until you finish
                 -> access_token "jh_live_…" (returned exactly once)

    You end up logged in as a side effect. Use the key as a bearer token:

        Authorization: Bearer jh_live_…

    Keys carry scopes "docs.read docs.write" and do not expire; revoke with
    POST /oauth2/revoke. Every API 401 carries a WWW-Authenticate header
    pointing back at the discovery metadata, so a cold agent can bootstrap.</pre></section>

<h1>ENDPOINTS</h1>
<section><pre>    API base: https://justhtml.sh/api/v1 — Authorization: Bearer jh_live_…
    Errors are JSON: {"error":"…","message":"…"}. OpenAPI: <a href="/api/spec.yaml">/api/spec.yaml</a>

    POST   /docs                       create      {html, title?, public?}
    GET    /docs                       list your docs
    GET    /docs/:slug                 fetch metadata + html
    PATCH  /docs/:slug                 update html / title / public
    DELETE /docs/:slug                 soft-delete
    POST   /docs/:slug/edits           apply patches {edits:[{oldText,newText}], base_version?}
    POST   /docs/:slug/rotate-token    new view token (the "un-share")
    GET    /docs/:slug/versions        version history
    GET    /docs/:slug/versions/:n     a specific version's html
    POST   /docs/:slug/grants          share {email|domain, role}  (owner only)
    GET    /docs/:slug/grants          list grants                 (owner only)
    DELETE /docs/:slug/grants/:id      revoke a grant              (owner only)

    Viewing (no auth):
    GET    /d/:slug                    viewer shell (chrome + sandboxed iframe)
    GET    /d/:slug/raw                zero-chrome HTML (CSP sandbox)
    GET    /d/:slug?viewtoken=…        required for private docs</pre></section>

<h1>EXAMPLES</h1>
<section><pre>    # Publish a private doc
    curl -s https://justhtml.sh/api/v1/docs \\
      -H "Authorization: Bearer $JUSTHTML_API_KEY" \\
      -H 'Content-Type: application/json' \\
      -d '{"html":"&lt;h1&gt;Hello&lt;/h1&gt;","title":"Demo"}'
    # -> {"slug":"fierce-tiger-12345","url":"https://justhtml.sh/d/fierce-tiger-12345",
    #     "view_token":"k7Pq2xWmRb", "version":1, "public":false, ...}
    # Share it:  https://justhtml.sh/d/fierce-tiger-12345?viewtoken=k7Pq2xWmRb

    # Edit it deterministically (always send base_version)
    curl -s https://justhtml.sh/api/v1/docs/fierce-tiger-12345/edits \\
      -H "Authorization: Bearer $JUSTHTML_API_KEY" -H 'Content-Type: application/json' \\
      -d '{"edits":[{"oldText":"Hello","newText":"Hi there"}],"base_version":1}'

    # Make it public
    curl -s -X PATCH https://justhtml.sh/api/v1/docs/fierce-tiger-12345 \\
      -H "Authorization: Bearer $JUSTHTML_API_KEY" -H 'Content-Type: application/json' \\
      -d '{"public":true}'

    # Share edit access with a teammate (their agent registers as that email)
    curl -s https://justhtml.sh/api/v1/docs/fierce-tiger-12345/grants \\
      -H "Authorization: Bearer $JUSTHTML_API_KEY" -H 'Content-Type: application/json' \\
      -d '{"email":"teammate@co.com","role":"editor"}'</pre></section>

<h1>LIMITS</h1>
<section><pre>    Resource quotas (per user)
      Max HTML size per doc        2 MB        -> 413 payload_too_large
      Docs per user                500         -> 403 quota_exceeded
      Versions retained per doc    100         oldest snapshots pruned
      Total storage per user       100 MB      current html + snapshots
      Grants per doc               50          -> 403 quota_exceeded
      API keys per user            10

    API rate limits (per API key)  -> 429 with Retry-After
      Doc creates                  60 / hour
      Writes (PATCH,/edits,grants,rotate) 60 / min
      Reads (GET)                  300 / min

    Unauthenticated viewer routes (per IP)   300 / min

    Limits live in one config module; agents can plan around them via
    <a href="/llms.txt">/llms.txt</a> and <a href="/api/spec.yaml">/api/spec.yaml</a>.</pre></section>

<h1>SEE ALSO</h1>
<section><pre>    <a href="/auth.md">/auth.md</a>           how agents sign up + authenticate (prose protocol)
    <a href="/llms.txt">/llms.txt</a>          terse agent-facing usage, every endpoint + curl
    <a href="/api/spec.yaml">/api/spec.yaml</a>     OpenAPI 3.1
    <a href="/login">/login</a>             human sign-in (magic link)
    <a href="/api/health">/api/health</a>        service + database health</pre></section>
`;
  return htmlResponse(
    manPage({
      title: "justhtml.sh — minimal HTML document host",
      center: "GENERAL",
      bodyHtml: body,
    })
  );
}
