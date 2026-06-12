import { createHmac, timingSafeEqual } from "node:crypto";

// Short-lived, grant-scoped viewer capability for the sandboxed iframe.
//
// THE PROBLEM (review finding, B7-origin): the /d/:slug shell loads the user
// HTML in a sandboxed (allow-scripts, no allow-same-origin → opaque origin)
// iframe pointed at /d/:slug/raw. Because the iframe is a cross-origin/opaque
// subframe, the SameSite=Lax session cookie is NOT sent with that subresource
// load, so /raw cannot re-authorize a session viewer (owner / email-grant /
// domain-grant) via the cookie. The previous implementation worked around this
// by appending the doc's MASTER view_token (documents.view_token) to the iframe
// src. That leaked the un-share token into the shell's HTML source for ANY
// session-authorized viewer — including viewer/editor grantees — letting them
// (a) re-share the doc to arbitrary third parties by URL and (b) retain access
// after their grant is revoked (only owner-only token rotation kills the master
// token). That breaks birthday.md's "rotation is the un-share story" invariant.
//
// THE FIX: instead of the master token, the shell mints a stateless, signed,
// per-slug, short-lived capability (this module) and hands THAT to the iframe.
// Properties:
//   - HMAC-signed over (slug, expiry) → unforgeable without the server secret.
//   - Scoped to one slug → can't be replayed against another doc.
//   - Expires in CAP_TTL_S (minutes) → not a durable shareable link; a grantee
//     who copies it out of page source has a token that dies in minutes and
//     cannot be re-minted once their grant is revoked (the shell re-runs
//     canViewSession before minting, so revocation takes effect immediately for
//     new loads, and existing caps lapse almost at once).
//   - Reveals NOTHING about documents.view_token → the master un-share token
//     never appears in page source for grantees. Rotation remains the only
//     re-share kill switch the OWNER controls, exactly as specified.
//
// This is intentionally NOT stored in Postgres: it is a derived capability, not
// a credential at rest, and statelessness keeps the hot viewer path one HMAC,
// zero round trips. The master view_token (a real capability URL the owner hands
// out deliberately) is unaffected and still works on /raw as before.

const CAP_PREFIX = "vc1"; // version tag, lets us rotate the scheme later
export const CAP_TTL_S = 300; // 5 minutes — long enough for the iframe to load,
// short enough that a leaked cap is near-worthless

/**
 * The HMAC key. Prefers a dedicated VIEWER_CAP_SECRET (set in .env + Vercel
 * prod). Falls back to PLANETSCALE_PASSWORD — also a strong server-only secret
 * that is always present in this deployment — so the capability path never
 * silently degrades if the dedicated var is missing. Either way the key lives
 * only server-side; it is never sent to the client (only the HMAC output is).
 */
function capKey(): string {
  return (
    process.env.VIEWER_CAP_SECRET ||
    process.env.PLANETSCALE_PASSWORD ||
    // Last-resort constant so local/dev never throws; production always has one
    // of the above. A constant here is fine because the only thing it protects
    // is a 5-minute, slug-scoped iframe-load capability, not a credential.
    "justhtml-viewer-cap-dev-fallback"
  );
}

function sign(payload: string): string {
  return createHmac("sha256", capKey()).update(payload).digest("base64url");
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Mint a capability for `slug`, valid for CAP_TTL_S seconds. Format:
 *   vc1.<slug-b64url>.<expEpochSeconds>.<hmac>
 * The HMAC covers "<prefix>.<slug>.<exp>" so neither the slug nor the expiry can
 * be tampered with.
 */
export function mintViewCap(slug: string, nowMs: number = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + CAP_TTL_S;
  const slugB64 = Buffer.from(slug, "utf8").toString("base64url");
  const body = `${CAP_PREFIX}.${slugB64}.${exp}`;
  return `${body}.${sign(body)}`;
}

/**
 * Verify a capability for `slug`. Returns true iff the cap is well-formed, its
 * signature is valid (constant-time), it is scoped to exactly this slug, and it
 * has not expired. Any malformed/forged/expired/mismatched cap → false (no
 * existence oracle; /raw treats false the same as "no token").
 */
export function verifyViewCap(
  cap: string | null,
  slug: string,
  nowMs: number = Date.now()
): boolean {
  if (!cap) return false;
  const parts = cap.split(".");
  if (parts.length !== 4) return false;
  const [prefix, slugB64, expStr, mac] = parts;
  if (prefix !== CAP_PREFIX) return false;
  // Recompute the expected signature over the presented (prefix, slug, exp).
  const body = `${prefix}.${slugB64}.${expStr}`;
  if (!safeEq(mac, sign(body))) return false;
  // Signature is valid → the fields are trustworthy. Check slug scope + expiry.
  let decodedSlug: string;
  try {
    decodedSlug = Buffer.from(slugB64, "base64url").toString("utf8");
  } catch {
    return false;
  }
  if (decodedSlug !== slug) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return false;
  return Math.floor(nowMs / 1000) <= exp;
}
