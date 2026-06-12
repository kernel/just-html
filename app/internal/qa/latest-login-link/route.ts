import { query } from "@/lib/db";
import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";

// QA ESCAPE HATCH — REMOVABLE POST-LAUNCH.
//
// GET /internal/qa/latest-login-link?email=… , guarded by header X-QA-Secret
// matching env QA_SECRET. Returns the most recent UNCONSUMED login link
// plaintext for that email (stored in qa_login_links only when QA_SECRET is
// set; see app/login/route.ts). Reviewers depend on this to complete the
// magic-link flow programmatically.
//
// To remove: unset QA_SECRET (disables the writes AND 404s this endpoint),
// then delete app/internal/qa/ and drop the qa_login_links table.

function secretOk(provided: string | null): boolean {
  const expected = process.env.QA_SECRET;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function GET(req: Request): Promise<Response> {
  // When QA mode is off, the endpoint does not exist.
  if (!process.env.QA_SECRET) return notFound();
  if (!secretOk(req.headers.get("x-qa-secret"))) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const url = new URL(req.url);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email) {
    return new Response(JSON.stringify({ error: "invalid_request", message: "email required" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const { rows } = await query<{ link: string; created_at: string }>(
    `SELECT link, created_at FROM qa_login_links
     WHERE email = $1 AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [email]
  );
  if (!rows[0]) {
    return new Response(JSON.stringify({ error: "no_link", email }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return new Response(
    JSON.stringify({ email, link: rows[0].link, created_at: rows[0].created_at }),
    { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }
  );
}
