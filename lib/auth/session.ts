import { query } from "@/lib/db";
import { sha256Hex, mintSessionToken } from "@/lib/auth/tokens";
import {
  SESSION_COOKIE,
  SESSION_TTL_S,
  SESSION_SLIDE_FLOOR_S,
} from "@/lib/auth/config";

// DB-backed sessions (§9.1). Opaque token in an HttpOnly/Secure/SameSite=Lax
// cookie; SHA-256 at rest. 30-day sliding expiry throttled to one write/hour.

export type Session = {
  id: number;
  email: string;
  user_id: number | null;
};

/** Parse the jh_sess cookie value out of a request's Cookie header. */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Resolve the current session from the cookie. One indexed lookup; applies the
 * sliding-expiry bump (throttled to 1/hour). Returns null when no valid
 * session.
 */
export async function getSession(req: Request): Promise<Session | null> {
  return getSessionFromToken(readSessionCookie(req));
}

/**
 * Token-level variant of getSession for callers that don't have a Request —
 * e.g. React server components reading the cookie via next/headers.
 */
export async function getSessionFromToken(raw: string | null): Promise<Session | null> {
  if (!raw || !raw.startsWith("sess_")) return null;
  const hash = sha256Hex(raw);
  const { rows } = await query<{
    id: number;
    email: string;
    user_id: number | null;
    last_seen_at: string;
  }>(
    `SELECT id, email, user_id, last_seen_at
     FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hash]
  );
  const row = rows[0];
  if (!row) return null;

  const lastSeen = new Date(row.last_seen_at).getTime();
  if (Date.now() - lastSeen > SESSION_SLIDE_FLOOR_S * 1000) {
    // Slide forward; throttled by the floor check above to avoid a write/request.
    query(
      `UPDATE sessions
       SET last_seen_at = now(), expires_at = now() + ($2 || ' seconds')::interval
       WHERE id = $1`,
      [row.id, String(SESSION_TTL_S)]
    ).catch(() => {});
  }

  return { id: row.id, email: row.email, user_id: row.user_id };
}

/**
 * Create a session for a verified email, backfilling user_id if an account
 * already exists. Returns the plaintext cookie token (returned exactly once)
 * plus the session id.
 */
export async function createSession(
  email: string
): Promise<{ token: string; sessionId: number; userId: number | null }> {
  const token = mintSessionToken();
  const hash = sha256Hex(token);
  const { rows } = await query<{ id: number; user_id: number | null }>(
    `INSERT INTO sessions (email, user_id, token_hash, expires_at)
     VALUES (
       $1,
       (SELECT id FROM users WHERE email = $1),
       $2,
       now() + ($3 || ' seconds')::interval
     )
     RETURNING id, user_id`,
    [email, hash, String(SESSION_TTL_S)]
  );
  return { token, sessionId: rows[0].id, userId: rows[0].user_id };
}

/** Set-Cookie header value for the session cookie. */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_S}`;
}
