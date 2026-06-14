import { query } from "@/lib/db";
import { sha256Hex } from "@/lib/auth/tokens";
import { API_KEY_LAST_USED_THROTTLE_S, WWW_AUTHENTICATE_CHALLENGE } from "@/lib/auth/config";

// Bearer API-key authentication for /api/v1/* (§3.5). Single indexed lookup on
// the SHA-256 of the presented key; bumps last_used_at (throttled).

export type ApiPrincipal = {
  apiKeyId: number;
  userId: number;
  email: string;
  scopes: string[];
};

/** 401 with the WWW-Authenticate discovery hint (§3.5). */
export function unauthorized(message = "Invalid, expired, or revoked credential."): Response {
  return new Response(JSON.stringify({ error: "unauthorized", message }), {
    status: 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "WWW-Authenticate": WWW_AUTHENTICATE_CHALLENGE,
    },
  });
}

/** Extract a Bearer token from the Authorization header (/^Bearer\s+(.+)$/i). */
export function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/**
 * Authenticate a request by API key. Returns the principal, or null if the
 * token is missing/invalid/revoked (caller responds with unauthorized()).
 */
export async function authenticate(req: Request): Promise<ApiPrincipal | null> {
  const token = extractBearer(req);
  if (!token) return null;
  const { rows } = await query<{
    id: number;
    user_id: number;
    email: string;
    scopes: string[];
    last_used_at: string | null;
  }>(
    `SELECT k.id, k.user_id, u.email, k.scopes, k.last_used_at
     FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.token_hash = $1 AND k.revoked_at IS NULL`,
    [sha256Hex(token)]
  );
  const row = rows[0];
  if (!row) return null;

  const last = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (Date.now() - last > API_KEY_LAST_USED_THROTTLE_S * 1000) {
    query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => {});
  }

  return { apiKeyId: row.id, userId: row.user_id, email: row.email, scopes: row.scopes };
}
