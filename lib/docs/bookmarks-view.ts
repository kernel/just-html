// Pure rendering for the /bookmarks list rows. Kept out of the route handler so
// the revoked / token-link / remove-button behavior is unit-testable without a
// DB. Matches the variant-C row look from /docs (bold title link + dimmed tail).
import { esc } from "@/lib/page";

/** YYYY-MM-DD — the terse one-line tail wants a date, not a timestamp. */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

export type RowModel = {
  docId: number;
  slug: string;
  title: string | null;
  // Resolved access label: owner | editor | commenter | viewer | public | link
  // | revoked. "link" means reachable only through the stored view token.
  access: string;
  isPublic: boolean;
  bookmarkedAt: string;
  linkable: boolean;
  // View token to re-append to the link so a token-shared doc stays reachable.
  token: string | null;
};

/** The remove form: a zero-JS POST keyed by doc id, so a bookmark — revoked or
 *  not — can be dropped from the list. */
function removeForm(docId: number): string {
  return `<form method="POST" action="/bookmarks" class="rm"><input type="hidden" name="action" value="remove"><input type="hidden" name="doc_id" value="${docId}"><input type="hidden" name="next" value="/bookmarks"><button type="submit" class="remove" title="Remove bookmark">remove</button></form>`;
}

/**
 * One bookmark row. A revoked bookmark shows just `<doc id> — revoked` with no
 * link (never the live title of a doc the viewer can no longer access). A live
 * bookmark shows the current title linking to the doc, carrying the stored view
 * token when the doc is reachable only through it.
 */
export function bookmarkRow(m: RowModel): string {
  const revoked = m.access === "revoked" || !m.linkable;
  if (revoked) {
    return `<div class="row revoked"><pre><span class="title">${m.docId}</span> <span class="tail">— revoked</span></pre>${removeForm(m.docId)}</div>`;
  }

  const label = m.title && m.title.trim() ? m.title : m.slug;
  const href = m.token
    ? `/d/${encodeURIComponent(m.slug)}?viewtoken=${encodeURIComponent(m.token)}`
    : `/d/${encodeURIComponent(m.slug)}`;
  const vis = m.isPublic ? "public" : "private";
  return `<div class="row"><pre><a class="title" href="${esc(href)}">${esc(label)}</a>  <span class="tail">${esc(m.access)} ${vis} · ${esc(fmtDate(m.bookmarkedAt))}</span></pre>${removeForm(m.docId)}</div>`;
}
