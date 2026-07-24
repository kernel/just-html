import { getSession } from "@/lib/auth/session";
import type { Session } from "@/lib/auth/session";
import { sanitizeNext } from "@/lib/auth/url";
import { canViewSession } from "@/lib/docs/access";
import { accessRoleLabel, resolveAccess } from "@/lib/docs/grants";
import { htmlResponse, manPage, esc, redirect } from "@/lib/page";
import { query } from "@/lib/db";
import {
  listBookmarks,
  saveBookmark,
  removeBookmark,
  type BookmarkDocRow,
  findBySlug,
} from "@/lib/docs/store";
import { bookmarkRow } from "@/lib/docs/bookmarks-view";

export const dynamic = "force-dynamic";

const LIST_LIMIT = 500;

// Rows lay out as a flex line: the man-page `<pre>` (title + dimmed tail) and a
// quiet inline `remove` form sitting on the same baseline.
const ROW_STYLE = `
<style>
  .row { display: flex; align-items: baseline; gap: 0.75rem; padding: 0.1rem 0; }
  .row pre { min-width: 0; }
  .row a.title { font-weight: 700; }
  .row .tail { color: #888; }
  .row.revoked .tail { color: #b00020; }
  .row .rm { margin: 0; }
  .row .remove { background: none; border: none; padding: 0; color: #888; text-decoration: underline; cursor: pointer; }
  .row .remove:hover { background: none; color: #b00020; }
</style>`;

async function accountOwnerId(email: string): Promise<number | null> {
  const { rows } = await query<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [email]);
  return rows[0]?.id ?? null;
}

/**
 * Re-resolve a shared bookmark's access using the token it was saved through
 * (owner/grant/public need none). Revoked → not linkable. A private doc still
 * reachable only via that token is labeled "link" and keeps the token so its
 * row links back with it appended.
 */
async function bookmarkAccess(
  doc: BookmarkDocRow,
  session: Session,
  ownerId: number | null
): Promise<{ access: string; linkable: boolean; token: string | null }> {
  if (doc.deleted_at) return { access: "revoked", linkable: false, token: null };

  if (!(await canViewSession(doc, session, doc.bookmark_token))) {
    return { access: "revoked", linkable: false, token: null };
  }

  const resolved = await resolveAccess(doc, session.email, ownerId ?? -1);
  if (resolved.kind === "owner") return { access: "owner", linkable: true, token: null };
  if (resolved.kind === "none") {
    // No grant: reachable via public, or only through the stored view token.
    return doc.is_public
      ? { access: "public", linkable: true, token: null }
      : { access: "link", linkable: true, token: doc.bookmark_token };
  }
  return { access: accessRoleLabel(resolved), linkable: true, token: null };
}

function emptySection(heading: string, copy: string): string {
  return `<h2>${heading}</h2>
<div class="body"><pre>${copy}</pre></div>`;
}

function section(heading: string, rows: string[]): string {
  return `<h2>${heading}</h2>
<div class="body">
${rows.join("\n")}
</div>`;
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

  const intro = `<div class="body"><pre>Signed in as <code>${esc(email)}</code>.\n\nBookmarks track current access. If a doc's access is later revoked it stays\nlisted with a revoked label and no link — use remove to drop it.</pre></div>`;

  const ownedRows = owned.map((doc) =>
    bookmarkRow({
      docId: doc.id,
      slug: doc.slug,
      title: doc.title,
      access: doc.deleted_at ? "revoked" : "owner",
      isPublic: doc.is_public,
      bookmarkedAt: doc.bookmarked_at,
      linkable: !doc.deleted_at,
      token: null,
    })
  );

  const sharedRows: string[] = [];
  for (const doc of shared) {
    const a = await bookmarkAccess(doc, session, ownerId);
    sharedRows.push(
      bookmarkRow({
        docId: doc.id,
        slug: doc.slug,
        title: doc.title,
        access: a.access,
        isPublic: doc.is_public,
        bookmarkedAt: doc.bookmarked_at,
        linkable: a.linkable,
        token: a.token,
      })
    );
  }

  const body = [
    ROW_STYLE,
    intro,
    owned.length
      ? section("YOUR DOCUMENTS", ownedRows)
      : emptySection(
          "YOUR DOCUMENTS",
          "You haven't bookmarked any of your own documents yet. Use the bookmark\nbutton on a doc to save it here."
        ),
    shared.length
      ? section("SHARED WITH YOU", sharedRows)
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
  const action = String(form.get("action") ?? "add").trim();
  const slug = String(form.get("slug") ?? "").trim();
  const next = sanitizeNext(
    String(form.get("next") ?? (slug ? `/d/${encodeURIComponent(slug)}` : "/bookmarks"))
  );

  // Remove is keyed by doc id so a revoked/deleted doc (whose slug no longer
  // resolves) can still be dropped. No access check: you can only ever remove
  // your own bookmark.
  if (action === "remove") {
    const docId = Number(form.get("doc_id"));
    if (Number.isInteger(docId)) await removeBookmark(session.email, docId);
    return redirect(next);
  }

  const viewtoken = String(form.get("viewtoken") ?? "").trim() || null;
  if (!slug) return redirect("/bookmarks");

  const doc = await findBySlug(slug);
  if (!doc || !(await canViewSession(doc, session, viewtoken))) {
    return redirect(next);
  }

  await saveBookmark(session.email, doc.id, viewtoken);
  return redirect(next);
}
