import {
  htmlToText,
  resolveQuote,
  buildOffsetMap,
  type TextAnchor,
  type Edit,
} from "@/lib/docs/anchor";

// Re-anchoring (birthday.md "How anchors survive edits"). Runs SYNCHRONOUSLY in
// the SAME transaction as every doc write (rewriteDoc, applyPatch). Docs are
// ≤2 MB and comment counts are small (≤1,000/doc), so this is cheap.
//
// Three tiers, smartest first:
//   1. Offset mapping through patches (edit_kind='patch'): exact changed ranges.
//      Anchors entirely before an edit are untouched; anchors after shift by the
//      length delta; anchors overlapping an edited range fall through to tier 2.
//   2. Quote re-finding (full rewrites, or tier-1 fallthrough): re-find `exact`
//      scored by prefix/suffix + proximity to the old offset. Ambiguous → tier 3.
//   3. Orphan: mark orphaned (kept, shown unanchored). If a later edit RESTORES
//      the text, re-anchoring un-orphans it (we always attempt tier 2 for
//      currently-orphaned comments too, so a restore re-resolves them).
//
// On success we update the stored anchor offsets (start/end) and anchored_version.

type DbClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

type CommentRow = {
  id: number;
  anchor: TextAnchor | null;
  anchored_version: number | null;
  orphaned: boolean;
};

/**
 * Re-anchor all anchored comments AND anchored reactions of a doc against the new
 * content, inside the caller's transaction. `edits` is provided for patch writes
 * (enables tier 1); pass undefined for full rewrites (tier 2 only). `newVersion`
 * is stamped onto anchored_version for every row we successfully (re)resolve.
 *
 * Doc-level / comment-level reactions and doc-level comments (anchor IS NULL) are
 * skipped entirely — they have nothing to anchor and never orphan. An orphaned
 * anchored reaction is recovered (un-orphaned) the same way comments are, if a
 * later edit restores the quoted text.
 */
export async function reanchorComments(
  client: DbClient,
  docId: number,
  oldHtml: string,
  newHtml: string,
  newVersion: number,
  edits?: Edit[]
): Promise<void> {
  const oldText = htmlToText(oldHtml);
  const newText = htmlToText(newHtml);
  const offsetMap = edits && edits.length ? buildOffsetMap(oldText, newText, edits) : null;

  // Anchored reactions ride the IDENTICAL tier-1/2/3 machinery as comments, in
  // the same transaction (birthday.md "Anchored reactions": "ride the SAME
  // tier-1/2/3 re-anchoring as comments on every doc write").
  await reanchorTable(client, "comments", docId, newText, newVersion, offsetMap, "deleted_at IS NULL AND ");
  await reanchorTable(client, "reactions", docId, newText, newVersion, offsetMap, "");
}

/**
 * Re-anchor one table's anchored rows (comments or reactions). Both carry the
 * same anchor / anchored_version / orphaned columns, so the three-tier logic is
 * shared. `extraWhere` lets comments filter soft-deleted rows; reactions have no
 * soft-delete.
 */
async function reanchorTable(
  client: DbClient,
  table: "comments" | "reactions",
  docId: number,
  newText: string,
  newVersion: number,
  offsetMap: ReturnType<typeof buildOffsetMap> | null,
  extraWhere: string
): Promise<void> {
  const { rows } = await client.query(
    `SELECT id, anchor, anchored_version, orphaned
       FROM ${table}
      WHERE doc_id = $1 AND ${extraWhere}anchor IS NOT NULL`,
    [docId]
  );
  const items = rows as CommentRow[];
  if (items.length === 0) return;

  for (const c of items) {
    if (!c.anchor || typeof c.anchor.exact !== "string") continue;
    const anchor = c.anchor;

    let resolvedStart: number | null = null;
    let resolvedEnd: number | null = null;

    // Tier 1: offset mapping (patch writes only, and only for non-orphaned
    // comments that have a known prior offset). A currently-orphaned comment has
    // no trustworthy offset, so it goes straight to tier 2 (which can un-orphan
    // it if the text was restored).
    if (offsetMap && !c.orphaned && typeof anchor.start === "number") {
      const newStart = offsetMap.map(anchor.start);
      const oldEnd = typeof anchor.end === "number" ? anchor.end : anchor.start + anchor.exact.length;
      const newEnd = offsetMap.map(oldEnd);
      if (newStart !== null && newEnd !== null) {
        // Verify the mapped span still contains the exact quote (cheap sanity
        // check — guards against an off-by-delta from an unlocatable sibling
        // edit). If it doesn't verify, fall through to tier 2.
        if (newText.slice(newStart, newStart + anchor.exact.length) === anchor.exact) {
          resolvedStart = newStart;
          resolvedEnd = newStart + anchor.exact.length;
        }
      }
    }

    // Tier 2: quote re-find (rewrites, tier-1 fallthrough, and orphan recovery).
    if (resolvedStart === null) {
      const hint = typeof anchor.start === "number" && !c.orphaned ? anchor.start : undefined;
      const r = resolveQuote(newText, anchor, hint);
      if (r.ok) {
        resolvedStart = r.start;
        resolvedEnd = r.end;
      }
    }

    if (resolvedStart !== null && resolvedEnd !== null) {
      // Success: update offsets + anchored_version, clear orphaned (un-orphan on
      // restore). Keep exact/prefix/suffix as-is (they're the durable selector).
      const updated: TextAnchor = {
        ...anchor,
        type: "text",
        start: resolvedStart,
        end: resolvedEnd,
      };
      await client.query(
        `UPDATE ${table}
            SET anchor = $2, anchored_version = $3, orphaned = false
          WHERE id = $1`,
        [c.id, JSON.stringify(updated), newVersion]
      );
    } else {
      // Tier 3: orphan (not_found or ambiguous). Keep the row + its anchor
      // selector so a later restoring edit can un-orphan it; just mark orphaned.
      // (An orphaned anchored REACTION degrades to doc-level display in the
      // rail header strip — handled at read time in allThreads.)
      if (!c.orphaned) {
        await client.query(
          `UPDATE ${table} SET orphaned = true, anchored_version = $2 WHERE id = $1`,
          [c.id, newVersion]
        );
      }
    }
  }
}
