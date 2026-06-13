import { htmlResponse } from "@/lib/page";

// Homepage — plain HTML, true man-page style (tail.1 / httpbingo.org vibe),
// always light mode, single JUSTHTML.SH(1) header, left-aligned sections with
// hanging-indent bodies, one quiet footer. The SYNOPSIS *is* the paste-to-your-
// agent prompt — the single hero element and the growth loop. NO API docs live
// here; those are canonical at /llms.txt and /api/spec.yaml.
//
// Served as a dynamic route-handler response (new Response(html)) per the style
// rules — NOT force-static (force-static turns handler output into a CDN static
// asset with stray headers). force-dynamic keeps it a real handler response.
export const dynamic = "force-dynamic";

// The copy-pasteable agent prompt. ONE line, no newlines — the box wraps, so
// embedded newlines would render as hard breaks. The agent reads auth.md +
// llms.txt and does the rest.
const AGENT_PROMPT =
  "I want to publish an HTML document to justhtml.sh. Read https://justhtml.sh/auth.md and https://justhtml.sh/llms.txt, then get me an API key and publish the doc. When you register I'll get an email with a 6-digit code — check with me and I'll read it back so you can finish. Give me back the shareable URL when done.";

// The one-line skill install command — the fastest path: install the skill,
// then the agent already knows how to use justhtml.sh.
const SKILL_INSTALL = "npx skills add kernel/just-html -g -y";

// Reused clipboard-copy button (one per .promptwrap; wired by the inline script).
const COPY_BTN = `<button class="copy" type="button" aria-label="Copy to clipboard" title="Copy"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.3"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v.5"/></svg></button>`;

export function GET() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>justhtml.sh(1)</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    padding: 2rem 1.5rem 3rem;
    max-width: 760px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace;
    font-size: 14px;
    line-height: 1.55;
    color: #111;
    background: #fff;
  }
  .headline { font-weight: 700; margin: 0 0 1.5rem; }
  h2 {
    font-size: 14px; font-weight: 700; margin: 1.6rem 0 0.3rem;
    text-transform: uppercase; letter-spacing: 0.03em;
  }
  pre { white-space: pre-wrap; margin: 0; }
  .body { padding-left: 3.5ch; }
  a { color: #0000ee; }
  .promptwrap { position: relative; }
  .prompt {
    background: #f6f6f6;
    border: 1px solid #ccc;
    border-radius: 4px;
    padding: 0.8rem 2.6rem 0.8rem 1rem;
    white-space: pre-wrap;
    user-select: all;
  }
  .copy {
    position: absolute; top: 0.5rem; right: 0.5rem;
    width: 1.7rem; height: 1.7rem; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    background: #fff; border: 1px solid #ccc; border-radius: 4px;
    color: #555; cursor: pointer; font-family: inherit; font-size: 11px;
    user-select: none;
  }
  .copy:hover { border-color: #999; color: #111; }
  .copy svg { width: 13px; height: 13px; }
  .hint { color: #666; margin: 0 0 0.5rem; }
  footer { margin-top: 2.5rem; color: #666; }
</style>
</head>
<body>
<pre class="headline">JUSTHTML.SH(1)</pre>

<h2>NAME</h2>
<div class="body"><pre>justhtml.sh — an agent-first minimal HTML document host</pre></div>

<h2>SYNOPSIS</h2>
<div class="body">
<p class="hint">Install the skill:</p>
<div class="promptwrap">
${COPY_BTN}
<pre class="prompt">${SKILL_INSTALL}</pre>
</div>
<p class="hint" style="margin-top:1.3rem;">Paste this to your agent — it does the rest:</p>
<div class="promptwrap">
${COPY_BTN}
<pre class="prompt">${AGENT_PROMPT}</pre>
</div>
</div>

<h2>DESCRIPTION</h2>
<div class="body"><pre>The agent self-onboards, gets an API key, and publishes HTML to stable
URLs like https://justhtml.sh/d/fierce-tiger-12345. Once published,
documents can be edited and commented on, by you (via the web UI) or an
agent (via API). Docs are private by default. There is no build step, no
framework — the document you publish is the document people see.</pre></div>

<h2>SEE ALSO</h2>
<div class="body"><pre><a href="/auth.md">auth.md</a>        how agents sign up + authenticate
<a href="/llms.txt">llms.txt</a>       terse agent-facing usage, every endpoint
<a href="/api/spec.yaml">spec.yaml</a>      OpenAPI 3.1
<a href="/docs">/docs</a>          your documents (sign in: owned + shared)
<a href="https://github.com/kernel/just-html">github</a>         source</pre></div>

<footer><pre>justhtml.sh                      2026-06-13                      JUSTHTML.SH(1)</pre></footer>

<script>
// The one intentional bit of JS on this page: a clipboard copy button. The
// prompt also has user-select:all, so copy works without JS too.
(function () {
  if (!navigator.clipboard) {
    document.querySelectorAll(".copy").forEach(function (b) { b.style.display = "none"; });
    return;
  }
  document.querySelectorAll(".promptwrap").forEach(function (wrap) {
    var btn = wrap.querySelector(".copy");
    var pre = wrap.querySelector(".prompt");
    if (!btn || !pre) return;
    btn.addEventListener("click", function () {
      navigator.clipboard.writeText(pre.textContent).then(function () {
        var prev = btn.innerHTML;
        btn.textContent = "ok";
        setTimeout(function () { btn.innerHTML = prev; }, 1200);
      });
    });
  });
})();
</script>
</body>
</html>`;
  return htmlResponse(html);
}
