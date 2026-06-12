import { manPage, htmlResponse } from "@/lib/page";

// Catch-all 404 — plain HTML, man-page style, zero JS. Brand rule: every page
// that can be plain HTML IS plain HTML. Next's default not-found ships a React
// runtime (<script> tags); this handler returns a handwritten 404 instead.
//
// A catch-all route handler is the lowest-priority match in the App Router:
// concrete and dynamic segments (app/route.ts, app/api/health/route.ts, and the
// B2/B3 handlers to come) all win over [...path], so this never shadows a real
// route — it only fires for genuinely unmatched URLs.
export const dynamic = "force-dynamic";

const PAGE = manPage({
  title: "404 — justhtml.sh",
  center: "GENERAL",
  bodyHtml: `
<h1>NOT FOUND</h1>
<section><pre>    404 — there is nothing at this path.</pre></section>

<h1>SEE ALSO</h1>
<section><pre>    GET <a href="/">/</a>              what justhtml.sh is
    GET <a href="/api/health">/api/health</a>    service + database health</pre></section>
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
