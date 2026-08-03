import { clearSessionCookieHeader, readSessionCookie } from "@/lib/auth/session";
import { originOk } from "@/lib/auth/request";
import { sha256Hex } from "@/lib/auth/tokens";
import { query } from "@/lib/db";
import { redirect } from "@/lib/page";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!originOk(req)) return new Response("Forbidden.", { status: 403 });

  const token = readSessionCookie(req);
  if (token?.startsWith("sess_")) {
    await query(
      `UPDATE sessions SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [sha256Hex(token)]
    );
  }

  return redirect("/login", { "Set-Cookie": clearSessionCookieHeader() });
}
