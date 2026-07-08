// Section deeplinks — stable per-heading fragment ids derived from the document
// HTML (GitHub/GFM-style slugs). This is the ONE definition of a "section id":
// the server computes the ordered heading list + ids here, the viewer shell
// forwards it to the overlay, and the overlay CONSUMES it (assigns each id to the
// heading at the same document-order index, paints the gutter link icon). The
// overlay is stringified browser JS and cannot import this module — same
// server-owns-identity split as lib/docs/anchor.ts's anchorSignature.
//
// STATELESS: ids are a pure function of the CURRENT html, recomputed each render
// (no storage, no re-anchoring). Editing a heading's text, or adding/removing/
// reordering headings, can change ids — the same behavior as GitHub anchors.
// Body-text edits that don't touch headings leave every id stable.

import { htmlToText } from "@/lib/docs/anchor";

export type Section = {
  id: string; // unique URL fragment (no leading '#')
  level: number; // 1..6 (the heading's h-level)
  text: string; // visible heading text (for matching + display)
};

// Comment permalinks live at #comment-<id> (see the CommentsShell hash router).
// Never mint a section id in that shape, so the two fragment namespaces can't
// collide even when a heading's text happens to slug to "comment-<n>".
const COMMENT_FRAGMENT = /^comment-\d+$/;

const HEADING_RE = /<(h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/gi;

// GFM-style slug of a heading's visible text: lowercase, drop punctuation /
// symbols / emoji, runs of whitespace become a single hyphen. Unicode-aware so
// non-Latin headings keep their letters rather than collapsing to empty.
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

// An author-provided id on the heading wins over a computed slug (respects any
// anchors the author already set). Matches id="x" / id='x' / id=x, but not
// data-id= or other *id attributes (must be at attribute-list start or preceded
// by whitespace).
function readId(attrs: string): string {
  const m = /(?:^|\s)id\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  if (!m) return "";
  return (m[2] ?? m[3] ?? m[4] ?? "").trim();
}

export function extractSections(html: string): Section[] {
  // Strip comments + script/style/template/noscript first so headings that only
  // appear there don't count — keeps the server heading set aligned with the
  // rendered DOM the overlay walks (it assigns ids by document-order index).
  // <template> content is inert and <noscript> is parsed as text while scripting
  // is on (when the overlay runs), so neither reaches the overlay's
  // document.querySelectorAll — counting them here would shift every later id.
  const masked = html
    .replace(/<!--[\s\S]*?-->/g, "")
    // Non-greedy, so nested same-tag blocks containing headings aren't handled —
    // the same accepted limit as before; that nesting is vanishingly rare.
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  const out: Section[] = [];
  const used = new Set<string>();
  // Dedupe in document order: the first occurrence of a base keeps it; later
  // collisions get -1, -2, … (GitHub's scheme). Also disambiguates a computed
  // slug that collides with an author id earlier in the doc.
  const uniquify = (base: string): string => {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let k = 1;
    while (used.has(`${base}-${k}`)) k++;
    const id = `${base}-${k}`;
    used.add(id);
    return id;
  };

  HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = HEADING_RE.exec(masked)) !== null) {
    n++;
    const level = Number(m[1][1]);
    const text = htmlToText(m[3]).replace(/\s+/g, " ").trim();
    const authorId = readId(m[2] || "");
    // Author id wins over a computed slug, but the reserved-namespace guard applies
    // to both: no section id may be shaped comment-<n> (the shell's hash router
    // would send it to a comment thread), so an author id="comment-5" becomes
    // section-comment-5 rather than hijacking that permalink.
    let base = authorId || slugify(text) || `section-${n}`;
    if (COMMENT_FRAGMENT.test(base)) base = `section-${base}`;
    out.push({ id: uniquify(base), level, text });
  }
  return out;
}
