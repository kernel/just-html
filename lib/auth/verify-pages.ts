import { manPage, esc } from "@/lib/page";

// Pure render helpers for GET /login/verify. Extracted from the route handler so
// they can be unit-tested without booting a server, hitting the DB, or making any
// network call. The route's GET/POST handlers import these; their logic is
// unchanged — these functions only build HTML strings from their arguments.

// GET render for the INVISIBLE auto-submit path, served only when the request
// carries the login-intent cookie — i.e. this is the same browser that just
// requested the link (see app/login/verify/route.ts). A tiny inline <script>
// submits the POST form on load, so that browser signs in without a visible
// click. Serving this ONLY to the cookie-bearing browser is what keeps it safe:
// a mail link scanner opening the emailed URL has no cookie, gets the no-JS
// confirmSignInPage instead, and so never runs this auto-submit to burn the
// single-use token. The form lives OUTSIDE <noscript> so the script can reach
// it; only the visible "sign in" button + instructions sit inside <noscript> for
// the no-JS fallback. The auto-submit is same-origin (page served from our
// origin, posts to /login/verify) so the POST Origin/CSRF check still passes.
// This is a deliberate, contained exception to zero-JS, like the homepage copy
// button.
export function signingInPage(token: string, next: string): string {
  return manPage({
    title: "justhtml.sh — signing you in",
    bodyHtml: `
<h2>SIGNING YOU IN</h2>
<div class="body"><pre>Signing you in…</pre></div>

<form id="verifyform" method="POST" action="/login/verify">
<input type="hidden" name="token" value="${esc(token)}">
<input type="hidden" name="next" value="${esc(next)}">
<noscript>
<div class="body"><pre>Click the button to finish signing in on this device.
<button type="submit">sign in</button></pre></div>
</noscript>
</form>
<script>document.getElementById('verifyform').submit();</script>

<noscript>
<div class="body"><pre>This link is single-use. If it's expired or already used you'll
be asked to <a href="/login">request a new one</a>.</pre></div>
</noscript>
`,
  });
}

// GET render when we CAN'T tie the click to the browser that requested the link
// (no login-intent cookie): a mail link scanner opening the emailed URL, a 7-day
// share/comment link, or a link opened in a different browser than the request.
// Renders the SAME POST form as signingInPage — identical hidden `token` +
// `next` — but with NO auto-submit <script>: the human taps the button to
// consume the single-use token. This is what makes the flow safe against
// JS-executing mail scanners. They fetch the URL and run its scripts (which is
// how they were burning the token off the invisible auto-submit shim before the
// human could tap), but they don't perform a real click, so the token survives.
export function confirmSignInPage(token: string, next: string): string {
  return manPage({
    title: "justhtml.sh — confirm sign-in",
    bodyHtml: `
<h2>ALMOST THERE</h2>
<div class="body"><pre>Tap the button to finish signing in on this device. This link is
single-use — if it's expired or already used you'll be asked to
<a href="/login">request a new one</a>.</pre></div>

<form method="POST" action="/login/verify">
<input type="hidden" name="token" value="${esc(token)}">
<input type="hidden" name="next" value="${esc(next)}">
<div class="body"><pre><button type="submit">sign in</button></pre></div>
</form>
`,
  });
}

// The dead-link page. CRITICAL: it must carry the sanitized `next` forward so an
// expired/consumed SHARE link degrades to one extra email round-trip, never a
// dead end (birthday.md "Stale-link fallback (always works)"). Without this, a
// grantee whose 7-day share link expired loses next=/d/:slug entirely and, being
// account-less, has no path back to the doc. We point "request a new one" at
// /login?next=<next> so re-sign-in lands them right back on the doc, where the
// session-grant check resolves their access.
export function deadLinkPage(next?: string): string {
  const dest = next && next !== "/login" ? next : null;
  const requestHref = dest
    ? `/login?next=${encodeURIComponent(dest)}`
    : "/login";
  return manPage({
    title: "justhtml.sh — link expired",
    bodyHtml: `
<h2>LINK EXPIRED OR USED</h2>
<div class="body"><pre>This login link is expired or already used.

Request a new one at <a href="${esc(requestHref)}">justhtml.sh/login</a>${
      dest
        ? ` — signing in again
will take you straight to where this link was headed.`
        : "."
    }</pre></div>
`,
  });
}
