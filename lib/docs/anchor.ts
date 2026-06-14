// Comment anchoring — W3C text-quote selectors + server-side re-anchoring
// (birthday.md "Comment anchoring", "How anchors survive edits").
//
// THE ANCHOR. A comment targets a span of the document via a text-quote selector
// (TextQuoteSelector + TextPositionSelector hint):
//   { type:"text", exact, prefix?, suffix?, start?, end? }
// `exact` is the verbatim quoted passage; prefix/suffix (~32 chars) disambiguate
// repeated text and survive surrounding shifts; start/end are offsets into the
// document's TEXT CONTENT (a fast-path hint, not authoritative). anchor === null
// is a doc-level comment.
//
// TEXT CONTENT, NOT DOM. Anchoring is against the document's text content, not
// DOM nodes (birthday.md), so spans crossing element boundaries are fine, and a
// human's selection and an agent's quote share one payload. The viewer overlay
// resolves quotes against the rendered DOM's text; the SERVER (this module)
// resolves against the same text content extracted from the stored HTML by
// stripping tags + decoding entities. The two text spaces agree closely enough
// for re-anchoring (the overlay re-resolves precisely against the live DOM when
// it paints; the server's job is only to keep offsets/orphan state honest across
// edits). When they disagree on whitespace, the prefix/suffix scoring tolerates
// it (we normalize runs of whitespace for scoring).

export type TextAnchor = {
  type?: "text";
  exact: string;
  prefix?: string;
  suffix?: string;
  start?: number;
  end?: number;
};

/** Validate + normalize an incoming anchor payload (from POST /comments). */
export function parseAnchor(input: unknown): { anchor: TextAnchor } | { error: string } {
  if (input === null || input === undefined) return { anchor: null as unknown as TextAnchor };
  if (typeof input !== "object") return { error: "anchor must be an object or null." };
  const a = input as Record<string, unknown>;
  if (typeof a.exact !== "string" || a.exact.length === 0) {
    return { error: "anchor.exact is required and must be a non-empty string." };
  }
  if (a.exact.length > 8000) {
    return { error: "anchor.exact is too long (max 8000 chars)." };
  }
  const out: TextAnchor = { type: "text", exact: a.exact };
  if (a.prefix !== undefined) {
    if (typeof a.prefix !== "string") return { error: "anchor.prefix must be a string." };
    out.prefix = a.prefix.slice(-64);
  }
  if (a.suffix !== undefined) {
    if (typeof a.suffix !== "string") return { error: "anchor.suffix must be a string." };
    out.suffix = a.suffix.slice(0, 64);
  }
  if (a.start !== undefined) {
    if (typeof a.start !== "number" || !Number.isFinite(a.start) || a.start < 0) {
      return { error: "anchor.start must be a non-negative number." };
    }
    out.start = Math.floor(a.start);
  }
  if (a.end !== undefined) {
    if (typeof a.end !== "number" || !Number.isFinite(a.end) || a.end < 0) {
      return { error: "anchor.end must be a non-negative number." };
    }
    out.end = Math.floor(a.end);
  }
  return { anchor: out };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

/**
 * Extract the document's text content from stored HTML, the way the browser
 * roughly would: drop <script>/<style> contents, strip tags, decode the common
 * named/numeric entities. NOT a full HTML parser (we have no DOM server-side and
 * don't want one in the hot write path) — but stable and deterministic, which is
 * all re-anchoring needs: it maps the same HTML to the same text every time, so
 * offset math and quote re-finding are consistent across versions.
 */
export function htmlToText(html: string): string {
  let s = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X"
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const lower = ent.toLowerCase();
    return ENTITIES[lower] ?? ENTITIES[ent] ?? m;
  });
  return s;
}

/** Collapse whitespace runs to a single space (for tolerant scoring). */
function squashWs(s: string): string {
  return s.replace(/\s+/g, " ");
}

export type ResolveResult =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: "not_found" | "ambiguous" };

/**
 * Re-find `anchor.exact` in `text`, scored by prefix/suffix agreement and
 * proximity to the old offset (tier 2 of re-anchoring; also the initial resolve).
 *
 * Algorithm (birthday.md "Quote re-finding"):
 *  - Collect every occurrence of `exact` in `text`.
 *  - Score each by how much of prefix (chars immediately before) and suffix
 *    (chars immediately after) agree, plus a small proximity bonus to the prior
 *    offset hint. Whitespace-insensitive comparison (tolerates tag-driven
 *    whitespace differences between DOM text and our extracted text).
 *  - Single candidate → take it. Multiple candidates: if there is a unique
 *    top score, take it; if the top score is tied across >1 candidate → ambiguous
 *    (refuse to guess → orphan). No occurrences → not_found (→ orphan).
 */
export function resolveQuote(
  text: string,
  anchor: TextAnchor,
  oldStart?: number
): ResolveResult {
  const exact = anchor.exact;
  if (exact.length === 0) return { ok: false, reason: "not_found" };

  const occ: number[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(exact, from);
    if (i === -1) break;
    occ.push(i);
    from = i + 1; // allow overlapping matches; harmless for distinct quotes
    if (occ.length > 5000) break; // pathological guard
  }
  if (occ.length === 0) return { ok: false, reason: "not_found" };
  if (occ.length === 1) return { ok: true, start: occ[0], end: occ[0] + exact.length };

  const wantPrefix = squashWs(anchor.prefix ?? "");
  const wantSuffix = squashWs(anchor.suffix ?? "");
  const hint = typeof oldStart === "number" ? oldStart : undefined;
  const span = Math.max(1, text.length);

  let best = -Infinity;
  let bestIdx = -1;
  let tie = false;
  for (const i of occ) {
    const beforeRaw = text.slice(Math.max(0, i - 80), i);
    const afterRaw = text.slice(i + exact.length, i + exact.length + 80);
    const before = squashWs(beforeRaw);
    const after = squashWs(afterRaw);
    let score = 0;
    if (wantPrefix) score += commonSuffixLen(before, wantPrefix);
    if (wantSuffix) score += commonPrefixLen(after, wantSuffix);
    if (hint !== undefined) {
      // proximity: up to ~10 points, decaying with distance from the old offset.
      score += 10 * (1 - Math.min(1, Math.abs(i - hint) / span));
    }
    if (score > best + 1e-9) {
      best = score;
      bestIdx = i;
      tie = false;
    } else if (Math.abs(score - best) <= 1e-9) {
      tie = true;
    }
  }
  // If prefix/suffix/hint give us nothing to discriminate (all-zero scores) and
  // there are multiple matches, that's genuine ambiguity → refuse.
  if (bestIdx === -1 || (tie && best <= 0 && !wantPrefix && !wantSuffix && hint === undefined)) {
    return { ok: false, reason: "ambiguous" };
  }
  if (tie) return { ok: false, reason: "ambiguous" };
  return { ok: true, start: bestIdx, end: bestIdx + exact.length };
}

/**
 * Resolve an anchor to a TEXT POSITION for document-order sorting (best-effort,
 * matching what the overlay paints). The ONE definition of the ordering rule
 * shared by the all-threads root sort and the anchored-reaction grouping in
 * lib/docs/comments: prefer the stored `start` offset; else re-find the quote
 * against the current doc text; if neither yields a finite offset, sort last
 * (Number.MAX_SAFE_INTEGER). For ordering only — never authoritative.
 */
export function anchorTextPos(docText: string, anchor: TextAnchor): number {
  let pos =
    typeof anchor.start === "number"
      ? anchor.start
      : (() => {
          const r = resolveQuote(docText, anchor, undefined);
          return r.ok ? r.start : Number.MAX_SAFE_INTEGER;
        })();
  if (!Number.isFinite(pos)) pos = Number.MAX_SAFE_INTEGER;
  return pos;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
function commonSuffixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

// The patch Edit shape ({oldText, newText}) has ONE definition — the vendored
// edit engine in edit-diff.ts. Re-exported here so callers that work in
// anchor/offset space (reanchor.ts) can keep importing it from this module.
export type { Edit } from "@/lib/docs/edit-diff";
import type { Edit } from "@/lib/docs/edit-diff";

/**
 * Tier-1 offset mapping for patch edits (birthday.md "Offset mapping through
 * patches"). Given the OLD text content and the patch edits, locate each edit's
 * changed range in the OLD TEXT and compute, for an old text offset, the
 * corresponding NEW text offset — or null if the offset falls INSIDE a changed
 * range (→ caller falls through to tier 2 / quote re-find).
 *
 * We work in TEXT-CONTENT space (the anchor's space), not HTML space: an edit's
 * oldText/newText are HTML fragments, but their effect on text content is what
 * moves an anchor. We map each edit to its text-content delta by finding the
 * edit's oldText's text in the old text content. Edits whose text can't be
 * located in the text content (e.g. they only touched tags/attributes, no
 * visible text) produce ZERO text-content delta and are skipped — anchors are
 * unaffected, which is correct.
 */
export type OffsetMap = {
  /** Map an old text offset to a new one; null if it lands inside an edited range. */
  map: (oldOffset: number) => number | null;
};

export function buildOffsetMap(oldText: string, newText: string, edits: Edit[]): OffsetMap {
  // Locate each edit's visible-text change as a (start, oldLen, newLen) range in
  // text-content space. Unlocatable or text-invisible edits are dropped.
  type Range = { start: number; oldLen: number; delta: number };
  const ranges: Range[] = [];
  for (const e of edits) {
    const oldFrag = htmlToText(e.oldText);
    const newFrag = htmlToText(e.newText);
    if (oldFrag.length === 0 && newFrag.length === 0) continue; // tag-only edit
    // Find the old fragment's text in the old text content. If it's not uniquely
    // locatable we skip tier-1 for this edit (the affected anchors will be
    // re-found in tier 2 against the new full text anyway).
    const first = oldFrag.length ? oldText.indexOf(oldFrag) : -1;
    if (oldFrag.length && first !== -1 && oldText.indexOf(oldFrag, first + 1) === -1) {
      ranges.push({ start: first, oldLen: oldFrag.length, delta: newFrag.length - oldFrag.length });
    } else {
      // Could not pin this edit in text space — signal a full fallthrough by
      // recording an "uncertain" sentinel covering nothing; resolveQuote handles
      // the rest. We simply don't add a range; tier 2 will re-find.
    }
  }
  ranges.sort((a, b) => a.start - b.start);

  return {
    map(oldOffset: number): number | null {
      let shift = 0;
      for (const r of ranges) {
        if (oldOffset < r.start) break; // before this edit — only prior shifts apply
        if (oldOffset <= r.start + r.oldLen) {
          // Offset is inside (or at the trailing edge of) an edited range →
          // can't map precisely; fall through to tier 2.
          return null;
        }
        shift += r.delta; // edit is entirely before the offset
      }
      return oldOffset + shift;
    },
  };
}

/**
 * THE ANCHOR SIGNATURE — the one canonical `prefix|exact|suffix` triple. This is
 * the DB unique-index dedup key (reactions.anchor_sig, the 0012/0013 index) AND
 * the GROUPING key the GET /comments response + the viewer overlay use to stack
 * span reactions. Server uniqueness, client grouping, and re-anchoring all agree
 * on "the same span" because they all run through THIS function. Non-anchored
 * targets (doc/comment level) get '' — COALESCE(comment_id,0) disambiguates them.
 * The signature is over the DECODED text-quote fields (what a human/agent quoted),
 * not the raw JSON, so two anchors differing only in offsets collide as the same
 * span — which is what toggle wants.
 *
 * The browser copies that cannot import server code (lib/docs/overlay.ts's
 * stringified JS, app/d/[slug]/CommentsShell.tsx's optimistic toggle) point here
 * as the source of truth and prefer the server-sent `sig` where one exists.
 */
export function anchorSignature(anchor: TextAnchor | null): string {
  if (!anchor) return "";
  return `${anchor.prefix ?? ""}|${anchor.exact}|${anchor.suffix ?? ""}`;
}

/**
 * Resolve an initial anchor against the current doc text: re-find the quote,
 * stamp start/end offsets, set orphaned if it can't be found, and serialize the
 * resolved anchor to JSON for storage. The ONE definition of the "resolve quote →
 * stamp offsets → set orphaned → JSON.stringify" block shared by createComment
 * (comments.ts) and addOrToggleReaction (reactions.ts), so a comment and a span
 * reaction born from the same quote land identically.
 *
 * Returns the column trio both callers persist: the JSON to store in `anchor`,
 * the `orphaned` flag, and the `anchored_version` (the doc version this was
 * resolved against). `anchor === null` (doc-level) yields all-null/false.
 */
export function resolveInitialAnchor(
  docHtml: string,
  anchor: TextAnchor | null,
  version: number
): { anchorJson: string | null; orphaned: boolean; anchoredVersion: number | null } {
  if (!anchor) return { anchorJson: null, orphaned: false, anchoredVersion: null };
  const docText = htmlToText(docHtml);
  const r = resolveQuote(docText, anchor, anchor.start);
  const resolved: TextAnchor = { ...anchor, type: "text" };
  let orphaned = false;
  if (r.ok) {
    resolved.start = r.start;
    resolved.end = r.end;
  } else {
    orphaned = true;
  }
  return { anchorJson: JSON.stringify(resolved), orphaned, anchoredVersion: version };
}
