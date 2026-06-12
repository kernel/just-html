import { timingSafeEqual } from "node:crypto";
import type { DocRow } from "@/lib/docs/store";

// View access resolution for the public viewer routes (/d/:slug, /d/:slug/raw).
//
// Token rules (identical for both routes, per birthday.md "Viewer routes"):
//   - public docs: anyone may view.
//   - private docs: require a matching ?viewtoken= in the query string.
// Owner/grant-based viewing for logged-in humans is a B5 concern (grants) and a
// future session-on-viewer concern; B3 ships the token + public path, which is
// the capability model the plan leans on.

/** Constant-time string equality (avoids leaking the view token via timing). */
export function safeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Decide whether a viewer presenting `viewtoken` (may be null) can view `doc`.
 * Public → always. Private → token must match (constant-time).
 */
export function canView(doc: DocRow, viewtoken: string | null): boolean {
  if (doc.is_public) return true;
  if (!viewtoken) return false;
  return safeStrEqual(viewtoken, doc.view_token);
}
