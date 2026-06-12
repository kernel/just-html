import { manPage, htmlResponse } from "@/lib/page";

// Homepage — plain HTML, man-page style, zero JS. Placeholder for B1.
// Full NAME/SYNOPSIS/EXAMPLES docs + copy-pasteable agent prompt land in B6.
export const dynamic = "force-static";

export function GET() {
  const body = `
<h1>NAME</h1>
<section><pre>    justhtml.sh — an agent-first minimal HTML document host</pre></section>

<h1>DESCRIPTION</h1>
<section><pre>    HTML is back. Agents constantly produce HTML specs, docs, outlines,
    and proposals. justhtml.sh is a site you point your agent at: the
    agent self-onboards, gets an API key, and publishes HTML documents
    to stable URLs like

        https://justhtml.sh/d/fierce-tiger-12345

    Docs are private by default, shareable via a short view token, and
    optionally public. No build step, no framework — the document you
    publish is the document people see.</pre></section>

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
