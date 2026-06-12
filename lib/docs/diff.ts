import { createTwoFilesPatch } from "diff";

// Server-side unified-patch generation for the history page (birthday.md
// "History"). Diffs are computed ON DEMAND from full version snapshots — the
// doc_versions.patch jsonb records what was REQUESTED; these patches record what
// actually RESULTED between two retained snapshots. We render them in the browser
// with @pierre/diffs (which accepts a unified-patch string and supports both
// unified and split layouts from the same input).
//
// `diff` is already a transitive dependency of @pierre/diffs, so this adds no new
// top-level dependency.

/**
 * Build a unified-diff patch string between two HTML snapshots, labeled by their
 * version numbers. 3 lines of context keeps the patch legible for typical edits.
 */
export function unifiedPatch(
  oldHtml: string,
  newHtml: string,
  oldVersion: number,
  newVersion: number
): string {
  return createTwoFilesPatch(
    `v${oldVersion}`,
    `v${newVersion}`,
    oldHtml,
    newHtml,
    undefined,
    undefined,
    { context: 3 }
  );
}
