import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// Secret minting + hashing (authmd-implementation.md §5). Every secret is
// stored as a SHA-256 hex digest; the plaintext is returned exactly once.

/** SHA-256 hex of a UTF-8 string. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Constant-time UTF-8 string equality — the ONE timing-safe string compare.
 * Returns false on length mismatch without leaking via early return. Used for the
 * view-token check (lib/docs/access.ts) and the viewer-capability HMAC compare
 * (lib/docs/viewcap.ts). safeEqualHex is the same primitive, kept under its
 * hex-named alias for the user_code verification call site.
 */
export function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Constant-time comparison of two SHA-256 hex digests. Used for the
 * low-entropy user_code verification (§5.2). Alias of safeEqualStr (same
 * UTF-8 byte comparison) named for that hex-digest call site.
 */
export const safeEqualHex = safeEqualStr;

function token(prefix: string, bytes: number): string {
  return prefix + randomBytes(bytes).toString("base64url");
}

/** reg_ + 16 random bytes base64url — registration wire id (public_id). */
export const mintRegistrationId = () => token("reg_", 16);
/** cla_ + 16 random bytes base64url — claim attempt wire id (public_id). */
export const mintClaimAttemptId = () => token("cla_", 16);
/** clm_ + 19 random bytes base64url — claim_token (held by agent). */
export const mintClaimToken = () => token("clm_", 19);
/** lt_ + 32 random bytes base64url — login magic-link token. */
export const mintLoginToken = () => token("lt_", 32);
/** sess_ + 32 random bytes base64url — session cookie token. */
export const mintSessionToken = () => token("sess_", 32);
/** jh_live_ + 32 random bytes base64url — long-lived API key. */
export const mintApiKey = () => token("jh_live_", 32);

/** 6-digit user_code from a CSPRNG, zero-padded (§3.1 step 4). */
export function mintUserCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
