// Deterministic edit engine — VENDORED + ADAPTED from pi's edit-diff.ts.
//
// Source: https://github.com/earendil-works/pi
//   packages/coding-agent/src/core/tools/edit-diff.ts (fetched 2026-06-12)
// pi is by earendil-works; this is an adaptation of their coding-agent edit tool.
// Original attribution preserved per the vendoring requirement.
//
// WHAT WE KEPT (verbatim logic): the matching philosophy — exact indexOf first,
// then a fuzzy fallback that NFKC-normalizes, strips trailing per-line whitespace,
// and folds smart quotes / unicode dashes / unicode spaces to ASCII; multi-edit
// application against the same base content with reverse-order splicing so offsets
// stay stable; and the hard-error set: empty oldText, not found, multiple matches
// (ambiguity), overlapping edits, and no-change.
//
// WHAT WE ADAPTED (server context, birthday.md "Editing"):
//   - Dropped the filesystem half (computeEditsDiff/readFile/access/path-utils,
//     BOM stripping, line-ending detection/restoration). The engine here operates
//     on an in-memory document string; the HTTP layer owns I/O and persistence.
//   - Dropped the `diff` npm dependency and the TUI display-diff renderer
//     (generateDiffString / generateUnifiedPatch). The history UI renders diffs
//     with @pierre/diffs from full version snapshots; we don't need pi's renderer.
//   - Replaced pi's string Error messages with a STRUCTURED EditApplyError that
//     names the failing edit index + a machine-readable reason code, so the HTTP
//     layer can return a 422 a calling agent can act on (birthday.md: "structured
//     422 naming the failing edit, so the calling agent can retry with more
//     context"). The human-readable wording mirrors pi's originals.
//   - normalizeToLF is applied to the edit oldText/newText (matching pi) but NOT
//     to the document content: user HTML is stored verbatim and we must not silently
//     rewrite a doc's line endings on a patch. Exact matching therefore happens
//     against the verbatim doc; the fuzzy path still LF-normalizes both sides.

export interface Edit {
  oldText: string;
  newText: string;
}

/** Machine-readable failure reasons for a patch apply (→ HTTP 422 reason codes). */
export type EditFailureReason =
  | "empty_old_text"
  | "not_found"
  | "multiple_matches"
  | "overlap"
  | "no_change";

/**
 * A structured, retryable patch failure. `editIndex` is the 0-based index of the
 * offending edit in the request's `edits` array (for "overlap" it is the first of
 * the overlapping pair; `otherEditIndex` is the second). `occurrences` is set for
 * "multiple_matches". `message` mirrors pi's human-readable wording.
 */
export class EditApplyError extends Error {
  readonly reason: EditFailureReason;
  readonly editIndex: number;
  readonly otherEditIndex?: number;
  readonly occurrences?: number;

  constructor(
    reason: EditFailureReason,
    editIndex: number,
    message: string,
    extra?: { otherEditIndex?: number; occurrences?: number }
  ) {
    super(message);
    this.name = "EditApplyError";
    this.reason = reason;
    this.editIndex = editIndex;
    this.otherEditIndex = extra?.otherEditIndex;
    this.occurrences = extra?.occurrences;
  }
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 * (Verbatim from pi's normalizeForFuzzyMatch.)
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      // Strip trailing whitespace per line
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Smart single quotes → '
      .replace(/[‘’‚‛]/g, "'")
      // Smart double quotes → "
      .replace(/[“”„‟]/g, '"')
      // Various dashes/hyphens → -
      // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
      // U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
      .replace(/[‐‑‒–—―−]/g, "-")
      // Special spaces → regular space
      // U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
      // U+205F medium math space, U+3000 ideographic space
      .replace(/[  -   　]/g, " ")
  );
}

interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
}

/**
 * Find oldText in content: exact indexOf first, then fuzzy (normalized) fallback.
 * (Adapted from pi's fuzzyFindText — same two-tier philosophy.)
 */
function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  }
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

/** Count fuzzy occurrences (ambiguity detection). Verbatim from pi. */
function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

/**
 * Apply one or more exact-text replacements to `content`.
 *
 * All edits are matched against the same base content. If ANY edit needs the
 * fuzzy path, the whole operation runs in fuzzy-normalized content space (so the
 * returned content is normalized) — preserving pi's single-vs-multi behavior.
 * Replacements are applied in reverse offset order so earlier offsets stay valid.
 *
 * Hard errors (all retryable, all structured): empty oldText, not found, multiple
 * matches, overlapping edits, no-change. Throws EditApplyError naming the edit.
 */
export function applyEdits(content: string, edits: Edit[]): string {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw new EditApplyError(
        "empty_old_text",
        i,
        normalizedEdits.length === 1
          ? "oldText must not be empty."
          : `edits[${i}].oldText must not be empty.`
      );
    }
  }

  // If any edit only matches fuzzily, do the whole apply in normalized space.
  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(content, edit.oldText));
  const baseContent = initialMatches.some((m) => m.usedFuzzyMatch)
    ? normalizeForFuzzyMatch(content)
    : content;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const matchResult = fuzzyFindText(baseContent, edit.oldText);
    if (!matchResult.found) {
      throw new EditApplyError(
        "not_found",
        i,
        normalizedEdits.length === 1
          ? "Could not find the exact text in the document. The oldText must match exactly, including all whitespace and newlines."
          : `Could not find edits[${i}] in the document. The oldText must match exactly, including all whitespace and newlines.`
      );
    }

    const occurrences = countOccurrences(baseContent, edit.oldText);
    if (occurrences > 1) {
      throw new EditApplyError(
        "multiple_matches",
        i,
        normalizedEdits.length === 1
          ? `Found ${occurrences} occurrences of the text in the document. The text must be unique — provide more surrounding context.`
          : `Found ${occurrences} occurrences of edits[${i}] in the document. Each oldText must be unique — provide more surrounding context.`,
        { occurrences }
      );
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  // Overlap detection: sort by match offset and ensure disjoint ranges.
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new EditApplyError(
        "overlap",
        previous.editIndex,
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in the document. Merge them into one edit, or target disjoint regions.`,
        { otherEditIndex: current.editIndex }
      );
    }
  }

  // Splice in reverse offset order so earlier match indices remain valid.
  let newContent = baseContent;
  for (let i = matchedEdits.length - 1; i >= 0; i--) {
    const edit = matchedEdits[i];
    newContent =
      newContent.substring(0, edit.matchIndex) +
      edit.newText +
      newContent.substring(edit.matchIndex + edit.matchLength);
  }

  if (baseContent === newContent) {
    throw new EditApplyError(
      "no_change",
      0,
      normalizedEdits.length === 1
        ? "No changes made — the replacement produced identical content."
        : "No changes made — the replacements produced identical content."
    );
  }

  return newContent;
}
