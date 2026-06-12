import { pingDb } from "@/lib/db";

// GET /api/health — liveness + real Postgres connectivity check.
// Always dynamic: it must hit the DB on every call, never cache.
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await pingDb();
  const body = JSON.stringify({ ok: db, db });
  return new Response(body, {
    status: db ? 200 : 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
