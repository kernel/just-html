import { manPage, htmlResponse } from "@/lib/page";

// Catch-all 404 — plain HTML, man-page style, zero JS. Brand rule: every page
// that can be plain HTML IS plain HTML. Next's default not-found ships a React
// runtime (<script> tags); this handler returns a handwritten 404 instead.
//
// A catch-all route handler is the lowest-priority match in the App Router:
// concrete and dynamic segments (app/route.ts, app/api/health/route.ts, and the
// B2/B3 handlers to come) all win over [...path], so this never shadows a real
// route — it only fires for genuinely unmatched URLs.
//
// Kept force-dynamic deliberately. The B1 review floated force-static to serve
// this from the edge cache, but a force-static route handler that returns a
// non-200 status (this one returns 404) is mis-served by Next: it prerenders the
// body but the runtime falls back to the framework error page and emits HTTP 500
// with a React error shell (verified against production 2026-06-12). Correctness
// (a real 404, zero JS) beats the marginal edge-cache saving on bogus-URL probes.
export const dynamic = "force-dynamic";

const PAGE = manPage({
  title: "404 — justhtml.sh",
  bodyHtml: `
<h2>NOT FOUND</h2>
<div class="body"><pre>404 — there is nothing at this path.</pre></div>

<h2>SEE ALSO</h2>
<div class="body"><pre><a href="/">/</a>              what justhtml.sh is
<a href="/api/health">/api/health</a>    service + database health</pre></div>
`,
});

function notFound(): Response {
  return htmlResponse(PAGE, { status: 404 });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
