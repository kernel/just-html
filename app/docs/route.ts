import { manPage, htmlResponse, esc, redirect } from "@/lib/page";
import { getSession } from "@/lib/auth/session";
import { listDocs, listSharedDocs, type DocListRow, type SharedDocRow } from "@/lib/docs/store";
import { emailDomain } from "@/lib/docs/grants";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /docs — the logged-in, man-page-styled, ZERO-JS docs listing
// (birthday.md "The docs page: /docs (v1)").
//
// Lists every document the session's email owns or has access to:
//   - OWNED section   : docs the session's account owns (access "owner").
//   - SHARED WITH YOU : docs granted to the session email (email grant) or its
//                       email-domain (domain grant), with the resolved role.
// Each row: title (fallback slug) linking to /d/:slug, access role, visibility,
// last-updated.
//
// Account-less sessions (a grantee who clicked a share link but never had their
// agent register) see their shared docs PLUS the "no account yet — tell your
// agent to sign up at justhtml.sh/auth.md" line. Not logged in → redirect to
// /login?next=/docs.
//
// Brand: plain HTML off a route handler, zero JS, zero React — consistent with
// every other man-page surface. The API twin is GET /api/v1/docs?scope=…

const LIST_LIMIT = 500;

// Variant C (LOCKED 2026-06-13): terse one-line rows. Title link, then a dimmed
// tail (`access vis · date · Nc`) on the SAME line. The extra row styling rides
// in this block (manPage() owns the shared chrome; this is the /docs fork).
const VARIANT_C_STYLE = `
<style>
  .row { padding: 0.1rem 0; }
  .row a.title { font-weight: 700; }
  .row .tail { color: #888; }
  .row .tail a { color: #888; }
</style>`;

// The paste-to-agent prompt and copy button, reused verbatim from the homepage
// (app/route.ts) for the account-less state (birthday.md /docs decision: the
// SAME prompt block as the homepage, INCLUDING the copy button). Carries its own
// scoped CSS + the single inline copy script (the only JS on this page, and the
// only JS explicitly sanctioned outside the homepage + viewer shell).
const AGENT_PROMPT =
  "I want to publish an HTML document to justhtml.sh. Read https://justhtml.sh/auth.md and https://justhtml.sh/llms.txt, then get me an API key and publish the doc. When you register I'll get an email with a 6-digit code — check with me and I'll read it back so you can finish. Give me back the shareable URL when done.";

const PROMPT_STYLE = `
<style>
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
</style>`;

const PROMPT_SCRIPT = `
<script>
(function () {
  var btn = document.getElementById("copy");
  var pre = document.getElementById("prompt");
  if (!btn || !pre || !navigator.clipboard) { if (btn) btn.style.display = "none"; return; }
  btn.addEventListener("click", function () {
    navigator.clipboard.writeText(pre.textContent).then(function () {
      var prev = btn.innerHTML;
      btn.textContent = "ok";
      setTimeout(function () { btn.innerHTML = prev; }, 1200);
    });
  });
})();
</script>`;

function fmtDate(iso: string): string {
  // YYYY-MM-DD — variant C's terse one-line tail wants a date, not a timestamp.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

/** One variant-C row: bold title link + a dimmed single-line tail. */
function docRow(opts: {
  slug: string;
  title: string | null;
  access: string;
  isPublic: boolean;
  updatedAt: string;
  commentCount: number;
}): string {
  const label = opts.title && opts.title.trim() ? opts.title : opts.slug;
  const href = `/d/${encodeURIComponent(opts.slug)}`;
  const vis = opts.isPublic ? "public" : "private";
  // Comment count: a compact `Nc` suffix (variant C), only when there are any.
  const comments = opts.commentCount > 0 ? ` · ${opts.commentCount}c` : "";
  return `<div class="row"><pre><a class="title" href="${esc(href)}">${esc(label)}</a>  <span class="tail">${esc(opts.access)} ${vis} · ${esc(fmtDate(opts.updatedAt))}${comments}</span></pre></div>`;
}

function ownedSection(owned: DocListRow[]): string {
  if (owned.length === 0) {
    return `<h2>YOUR DOCUMENTS</h2>
<div class="body"><pre>You don't own any documents yet. Your agent publishes them via the
API (POST /api/v1/docs) using the key it holds — see <a href="/llms.txt">/llms.txt</a>.</pre></div>`;
  }
  const rows = owned.map((d) =>
    docRow({
      slug: d.slug,
      title: d.title,
      access: "owner",
      isPublic: d.is_public,
      updatedAt: d.updated_at,
      commentCount: d.comment_count,
    })
  );
  return `<h2>YOUR DOCUMENTS</h2>
<div class="body">
${rows.join("\n")}
</div>`;
}

function sharedSection(shared: SharedDocRow[]): string {
  if (shared.length === 0) {
    return `<h2>SHARED WITH YOU</h2>
<div class="body"><pre>Nothing is shared with you yet. When someone grants your email (or
your email's domain) access to a doc, it shows up here.</pre></div>`;
  }
  const rows = shared.map((d) =>
    docRow({
      slug: d.slug,
      title: d.title,
      access: d.access,
      isPublic: d.is_public,
      updatedAt: d.updated_at,
      commentCount: d.comment_count,
    })
  );
  return `<h2>SHARED WITH YOU</h2>
<div class="body">
${rows.join("\n")}
</div>`;
}

// Account-less sessions (a grantee who clicked a share link but never had their
// agent register). LOCKED copy fix (birthday.md): lead with "you're signed in
// as <email>, but you haven't set up your account yet", then the SAME
// paste-to-agent prompt block as the homepage, copy button included.
function noAccountSection(email: string): string {
  return `<h2>NO ACCOUNT YET</h2>
<div class="body">
<p class="hint">You're signed in as <code>${esc(email)}</code>, but you haven't set up your account yet. Copy and paste this to your agent:</p>
<div class="promptwrap">
<button class="copy" id="copy" type="button" aria-label="Copy to clipboard" title="Copy">
<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.3"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v.5"/></svg>
</button>
<pre class="prompt" id="prompt">${AGENT_PROMPT}</pre>
</div>
</div>`;
}

export async function GET(req: Request): Promise<Response> {
  const session = await getSession(req);
  // Not logged in → redirect to /login?next=/docs (the magic-link flow returns
  // here after sign-in).
  if (!session) return redirect("/login?next=%2Fdocs");

  const email = session.email;
  const domain = emailDomain(email);

  // Resolve whether this session is backed by an account. user_id may be null on
  // a session minted before the account existed (the grantee flow: a share-link
  // sign-in for an email that has no account yet); re-resolve by email so a
  // now-existing account is reflected without re-login.
  let hasAccount = session.user_id != null;
  let ownerId = session.user_id;
  if (!hasAccount) {
    const { rows } = await query<{ id: number }>(
      `SELECT id FROM users WHERE email = $1`,
      [email]
    );
    if (rows[0]) {
      hasAccount = true;
      ownerId = rows[0].id;
    }
  }

  const owned = hasAccount && ownerId != null ? await listDocs(ownerId, LIST_LIMIT) : [];
  const shared = await listSharedDocs(email, domain, ownerId, LIST_LIMIT);

  // Header line: "Signed in as <email>." The `account · API` links are CUT
  // (birthday.md /docs decision: not needed).
  const sections: string[] = [];
  sections.push(VARIANT_C_STYLE);
  sections.push(`<div class="body"><pre>Signed in as <code>${esc(email)}</code>.</pre></div>`);
  if (hasAccount) {
    sections.push(ownedSection(owned));
  } else {
    // Account-less: the homepage prompt block (with copy button) needs its
    // scoped CSS + the single inline copy script.
    sections.push(PROMPT_STYLE);
    sections.push(noAccountSection(email));
  }
  sections.push(sharedSection(shared));
  if (!hasAccount) sections.push(PROMPT_SCRIPT);

  return htmlResponse(
    manPage({
      title: "justhtml.sh — your documents",
      bodyHtml: sections.join("\n"),
    })
  );
}
