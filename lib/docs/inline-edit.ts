import type { Edit } from "@/lib/docs/edit-diff";

// Inline editing — turning in-browser text edits into deterministic patches.
//
// The viewer's edit mode (overlay → CommentsShell → POST /edits) never
// serializes the DOM back to HTML. A DOM round-trip would rewrite the whole
// document on every save — attribute order, entity forms, void-element spelling,
// script-rendered subtrees (Mermaid) — and /d/:slug/raw serving the author's
// bytes verbatim is the product. So the overlay reports, per edited TEXT NODE,
// the text before and after; this module turns those pairs into the same
// {oldText,newText} edits an agent posts to /edits, and the existing engine
// (lib/docs/edit-diff.ts) applies them against the stored HTML.
//
// WHY A TEXT NODE IS THE RIGHT UNIT: the parser built each text node from one
// contiguous run of the source, so its content appears verbatim in the stored
// HTML and an exact indexOf finds it. Anything coarser (a block's innerHTML)
// requires re-serializing markup; anything finer has no stable identity.
//
// ENTITIES ARE THE ONE LEAK. `&amp;` in the source parses to `&` in the DOM, so
// the DOM text is NOT a substring of the source. Which spelling the author used
// is unknowable from inside the iframe, so we emit TWO payloads — literal and
// entity-escaped — and the caller tries the literal one first, falling back on a
// `not_found` 422. newText is escaped in BOTH: typing "<b>" must land in the
// document as text, not as markup.

/** One text node's content before and after the user's edit. */
export type TextChange = { before: string; after: string };

/**
 * The two candidate edit payloads for one save. `edits` assumes the source spells
 * the text literally; `escaped` assumes it used entities. Try `edits`, then
 * `escaped` if the engine reports `not_found`.
 */
export type InlineEditPayloads = { edits: Edit[]; escaped: Edit[] };

/** Minimal HTML text-node escaping — what we write back into the document. */
export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escaping for MATCHING against source that used entities. Adds the non-breaking
 * space, which authors overwhelmingly write as `&nbsp;` and the parser hands back
 * as U+00A0 — the single most common reason a literal match misses.
 */
export function escapeHtmlSource(s: string): string {
  return escapeHtmlText(s).replace(/\u00a0/g, "&nbsp;");
}

/**
 * Build both edit payloads from the overlay's reported text-node changes.
 * Returns null when there is nothing to save: no changes, or only changes we
 * cannot express (an empty `before` has no unique anchor in the source, and the
 * engine rejects an empty oldText outright).
 */
export function buildInlineEdits(changes: TextChange[]): InlineEditPayloads | null {
  const real = changes.filter((c) => c.before !== c.after && c.before !== "");
  if (real.length === 0) return null;
  return {
    edits: real.map((c) => ({ oldText: c.before, newText: escapeHtmlText(c.after) })),
    escaped: real.map((c) => ({
      oldText: escapeHtmlSource(c.before),
      newText: escapeHtmlSource(c.after),
    })),
  };
}
