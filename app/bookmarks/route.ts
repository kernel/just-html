import { getSession } from "@/lib/auth/session";
import type { Session } from "@/lib/auth/session";
import { sanitizeNext } from "@/lib/auth/url";
import { canViewSession } from "@/lib/docs/access";
import { accessRoleLabel, resolveAccess } from "@/lib/docs/grants";
import { htmlResponse, manPage, esc, redirect } from "@/lib/page";
import { query } from "@/lib/db";
import { listBookmarks, saveBookmark, type BookmarkDocRow, findBySlug } from "@/lib/docs/store";

export const dynamic = "force-dynamic";

const LIST_LIMIT = 500;

const ROW_STYLE = `
<style>
  .row { padding: 0.1rem 0; }
  .row a.title { font-weight: 700; }
  .row .tail { color: #888; }
  .row .tail a { color: #888; }
  .row.revoked .tail { color: #b00020; }
</style>`;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function row(opts: {
  slug: string;
  title: string | null;
  access: string;
  isPublic: boolean;
  bookmarkedAt: string;
  linkable: boolean;
}): string {
  const label = opts.title && opts.title.trim() ? opts.title : opts.slug;
  const href = `/d/${encodeURIComponent(opts.slug)}`;
  const vis = opts.isPublic ? "public" : "private";
  const title = opts.linkable
    ? `<a class="title" href="${esc(href)}">${esc(label)}</a>`
    : `<span class="title">${esc(label)}</span>`;
  return `<div class="row${opts.access === "revoked" ? " revoked" : ""}"><pre>${title}  <span class="tail">${esc(opts.access)} ${vis} · ${esc(fmtDate(opts.bookmarkedAt))}</span></pre></div>`;
}

async function accountOwnerId(email: string): Promise<number | null> {
  const { rows } = await query<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [email]);
  return rows[0]?.id ?? null;
}

async function bookmarkAccess(
  doc: BookmarkDocRow,
  session: Session,
  ownerId: number | null
): Promise<{ access: string; linkable: boolean }> {
  if (doc.deleted_at) return { access: "revoked", linkable: false };

  if (ownerId != null && doc.owner_id === ownerId) {
    return { access: "owner", linkable: true };
  }

  if (!(await canViewSession(doc, session, null))) {
    return { access: "revoked", linkable: false };
  }

  const resolved = await resolveAccess(doc, session.email, ownerId ?? -1);
  if (resolved.kind === "owner") return { access: "owner", linkable: true };
  if (resolved.kind === "none") return { access: "public", linkable: true };
  return { access: accessRoleLabel(resolved), linkable: true };
}

function emptySection(heading: string, copy: string): string {
  return `<h2>${heading}</h2>
<div class="body"><pre>${copy}</pre></div>`;
}

export async function GET(req: Request): Promise<Response> {
  const session = await getSession(req);
  if (!session) return redirect("/login?next=%2Fbookmarks");

  const email = session.email;
  const ownerId = session.user_id ?? (await accountOwnerId(email));
  const bookmarks = await listBookmarks(email, LIST_LIMIT);

  const owned: BookmarkDocRow[] = [];
  const shared: BookmarkDocRow[] = [];
  for (const bookmark of bookmarks) {
    if (ownerId != null && bookmark.owner_id === ownerId) owned.push(bookmark);
    else shared.push(bookmark);
  }

  const intro = `<div class="body"><pre>Signed in as <code>${esc(email)}</code>.\n\nBookmarks track current access. If a bookmarked doc is later revoked, it stays\nlisted here with a revoked label and no link.</pre></div>`;

  const ownedRows: string[] = [];
  for (const doc of owned) {
    const access = doc.deleted_at ? "revoked" : "owner";
    ownedRows.push(
      row({
        slug: doc.slug,
        title: doc.title,
        access,
        isPublic: doc.is_public,
        bookmarkedAt: doc.bookmarked_at,
        linkable: access !== "revoked",
      })
    );
  }

  const sharedRows: string[] = [];
  for (const doc of shared) {
    const access = await bookmarkAccess(doc, session, ownerId);
    sharedRows.push(
      row({
        slug: doc.slug,
        title: doc.title,
        access: access.access,
        isPublic: doc.is_public,
        bookmarkedAt: doc.bookmarked_at,
        linkable: access.linkable,
      })
    );
  }

  const body = [
    ROW_STYLE,
    intro,
    owned.length
      ? `<h2>YOUR DOCUMENTS</h2>
<div class="body">
${ownedRows.join("\n")}
</div>`
      : emptySection(
          "YOUR DOCUMENTS",
          "You haven't bookmarked any of your own documents yet. Use the bookmark\nbutton on a doc to save it here."
        ),
    shared.length
      ? `<h2>SHARED WITH YOU</h2>
<div class="body">
${sharedRows.join("\n")}
</div>`
      : emptySection(
          "SHARED WITH YOU",
          "Nothing shared with you is bookmarked yet. Use the bookmark button on a\ndoc to save it here."
        ),
  ].join("\n");

  return htmlResponse(
    manPage({
      title: "justhtml.sh — bookmarks",
      bodyHtml: body,
    })
  );
}

export async function POST(req: Request): Promise<Response> {
  const session = await getSession(req);
  if (!session) return redirect("/login?next=%2Fbookmarks");

  const form = await req.formData();
  const slug = String(form.get("slug") ?? "").trim();
  const viewtoken = String(form.get("viewtoken") ?? "").trim() || null;
  const next = sanitizeNext(String(form.get("next") ?? (slug ? `/d/${encodeURIComponent(slug)}` : "/bookmarks")));

  if (!slug) return redirect("/bookmarks");

  const doc = await findBySlug(slug);
  if (!doc || !(await canViewSession(doc, session, viewtoken))) {
    return redirect(next);
  }

  await saveBookmark(session.email, doc.id);
  return redirect(next);
}
