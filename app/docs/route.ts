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

function fmtDate(iso: string): string {
  // YYYY-MM-DD HH:MM UTC — compact, monospace-friendly, no JS/locale surprises.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** One table-ish row in a section, rendered as fixed-column monospace text. */
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
  // Comment count (birthday.md B11: dashboard rows gain a comment count). Only
  // shown when there are any, to keep zero-comment rows uncluttered.
  const comments =
    opts.commentCount > 0
      ? ` · ${opts.commentCount} comment${opts.commentCount === 1 ? "" : "s"}`
      : "";
  // Title link, then a meta line beneath it (access · visibility · updated · comments).
  return `    <a href="${esc(href)}">${esc(label)}</a>
      ${esc(opts.access)} · ${vis} · updated ${esc(fmtDate(opts.updatedAt))}${comments} · <a href="${esc(href)}">${esc(opts.slug)}</a>`;
}

function ownedSection(owned: DocListRow[]): string {
  if (owned.length === 0) {
    return `<h1>YOUR DOCUMENTS</h1>
<section><pre>    You don't own any documents yet. Your agent publishes them via the
    API (POST /api/v1/docs) using the key it holds — see <a href="/llms.txt">/llms.txt</a>.</pre></section>`;
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
  return `<h1>YOUR DOCUMENTS</h1>
<section><pre>${rows.join("\n\n")}</pre></section>`;
}

function sharedSection(shared: SharedDocRow[]): string {
  if (shared.length === 0) {
    return `<h1>SHARED WITH YOU</h1>
<section><pre>    Nothing is shared with you yet. When someone grants your email (or
    your email's domain) access to a doc, it shows up here.</pre></section>`;
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
  return `<h1>SHARED WITH YOU</h1>
<section><pre>${rows.join("\n\n")}</pre></section>`;
}

// The "no account yet" line for account-less sessions (a grantee who never
// registered). Mirrors the dashboard-lite copy in /login.
function noAccountSection(): string {
  return `<h1>NO ACCOUNT YET</h1>
<section><pre>    You're signed in, but you don't have a justhtml.sh account yet.
    Sign-up is agent-only — tell your agent to sign up at
    <a href="/auth.md">justhtml.sh/auth.md</a>. It registers with this email, shows you a
    6-digit code and a link, and you confirm right here. You end up with
    an account and your agent holds the API key.</pre></section>`;
}

export async function GET(req: Request): Promise<Response> {
  const session = await getSession(req);
  // Not logged in → redirect to /login?next=/docs (the magic-link flow returns
  // here after sign-in).
  if (!session) return redirect("/login?next=%2Fdocs");

  const email = session.email;
  const domain = emailDomain(email);

  // Resolve whether this session is backed by an account. user_id may be null on
  // a session minted before the account existed (claim ceremony / grantee flow);
  // re-resolve by email so a now-existing account is reflected without re-login.
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

  const sections: string[] = [];
  sections.push(`<section><pre>    Signed in as <code>${esc(email)}</code>. <a href="/login">account</a> · <a href="/llms.txt">API</a></pre></section>`);
  if (hasAccount) {
    sections.push(ownedSection(owned));
  } else {
    sections.push(noAccountSection());
  }
  sections.push(sharedSection(shared));

  return htmlResponse(
    manPage({
      title: "justhtml.sh — your documents",
      center: "DOCS",
      bodyHtml: sections.join("\n"),
    })
  );
}
