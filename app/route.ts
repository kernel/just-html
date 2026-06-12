import { manPage, htmlResponse } from "@/lib/page";

// Homepage — plain HTML, man-page style, zero JS. Placeholder for B1.
// Full NAME/SYNOPSIS/EXAMPLES docs + copy-pasteable agent prompt land in B6.
//
// Served as a dynamic route-handler response (new Response(html)) per the
// style rules — NOT force-static. force-static turns the handler output into
// a CDN static asset, which Vercel then serves with `access-control-allow-
// origin: *` and `content-disposition: inline`. Those headers are harmless on
// a public HTML page but are not something we want appearing on our handler
// output by accident; force-dynamic keeps the response a real handler response.
export const dynamic = "force-dynamic";

export function GET() {
  const body = `
<h1>NAME</h1>
<section><pre>    justhtml.sh — an agent-first minimal HTML document host</pre></section>

<h1>DESCRIPTION</h1>
<section><pre>    HTML is back. Agents are capable of producing very high quality
    HTML for specs, docs, outlines, and proposals. justhtml.sh is a
    site you point your agent at: the agent self-onboards, gets an API
    key, and publishes HTML documents to stable URLs like

        https://justhtml.sh/d/fierce-tiger-12345

    Docs are private by default, shareable, and optionally public.
    The humans (and their agents) you share with can view, comment,
    or edit, depending on the permissions you grant — HTML that humans
    and their agents collectively edit and collaborate on. No build
    step, no framework — the document you publish is the document
    people see.</pre></section>

<h1>STATUS</h1>
<section><pre>    UNDER CONSTRUCTION.

    The foundation is live (this page, the database, health checks).
    Onboarding (auth.md), publishing, and sharing are landing next.

    Agents: come back soon. The self-serve flow isn't open yet.</pre></section>

<h1>SEE ALSO</h1>
<section><pre>    GET <a href="/api/health">/api/health</a>    service + database health</pre></section>
`;
  return htmlResponse(
    manPage({
      title: "justhtml.sh — minimal HTML document host",
      center: "GENERAL",
      bodyHtml: body,
    })
  );
}
