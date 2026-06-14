import { query } from "@/lib/db";
import type { DocRow } from "@/lib/docs/store";
import type { Session } from "@/lib/auth/session";
import { emailDomain } from "@/lib/docs/grants";
import { safeEqualStr } from "@/lib/auth/tokens";

// View access resolution for the viewer routes (/d/:slug, /d/:slug/raw).
//
// Viewer-route authorization order (birthday.md "Viewer-route enforcement"),
// most → least privileged:
//   1. owner session       — session email belongs to the doc's owner
//   2. email-grant session — session email matches an 'email' grant on the doc
//   3. domain-grant session— session email-domain matches a 'domain' grant
//   4. valid view token    — ?viewtoken= matches (constant-time)
//   5. public              — is_public
// Editor-granted humans VIEW via the web; web editing is not v1 (their agent
// edits via the API). So a grant of ANY role authorizes viewing here.

/**
 * Token/public-only view check (no session). Public → always. Private → the
 * presented viewtoken must match (constant-time, via safeEqualStr — the one
 * timing-safe string compare in lib/auth/tokens.ts). Used where no session
 * context is in play; the session-aware path is canViewSession below.
 */
export function canView(doc: DocRow, viewtoken: string | null): boolean {
  if (doc.is_public) return true;
  if (!viewtoken) return false;
  return safeEqualStr(viewtoken, doc.view_token);
}

/**
 * Does this session's email have a grant (of any role) on this doc — explicit
 * email grant OR matching domain grant? One indexed lookup. Domain grants never
 * match a consumer-provider email here because consumer-domain grants are
 * rejected at creation time, so there is no row to match.
 */
async function sessionHasGrant(docId: number, email: string): Promise<boolean> {
  const lower = email.toLowerCase();
  const domain = emailDomain(lower);
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) AS n FROM doc_grants
     WHERE doc_id = $1
       AND ( (grantee_type = 'email'  AND grantee = $2)
          OR (grantee_type = 'domain' AND grantee = $3) )`,
    [docId, lower, domain]
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** True if `email` is the registered owner of `doc` (one indexed lookup). */
async function emailOwnsDoc(doc: DocRow, email: string): Promise<boolean> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) AS n FROM users
     WHERE id = $1 AND email = $2`,
    [doc.owner_id, email.toLowerCase()]
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Session-aware viewer authorization (birthday.md "Viewer-route enforcement").
 * Resolves owner → email grant → domain grant → view token → public, in order.
 * `session` may be null (anonymous viewer with maybe a view token); `userId` on
 * the session is nullable (a grantee who never registered still has a valid
 * email-keyed session — that's the whole point of the share-notification flow).
 */
export async function canViewSession(
  doc: DocRow,
  session: Session | null,
  viewtoken: string | null
): Promise<boolean> {
  if (session) {
    // 1. Owner session — the session's verified email owns the doc. Match on
    //    user_id when the session carries one (normal logged-in owner); fall
    //    back to an email→owner check so an owner whose session predates their
    //    account (user_id not yet backfilled) still views their own doc.
    if (session.user_id != null && session.user_id === doc.owner_id) return true;
    if (session.user_id == null && (await emailOwnsDoc(doc, session.email))) return true;
    // 2 + 3. Email grant, then domain grant, keyed by the verified session email.
    if (await sessionHasGrant(doc.id, session.email)) return true;
  }
  // 4 + 5. View token, then public.
  return canView(doc, viewtoken);
}
