import { query } from "@/lib/db";
import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";

// QA ESCAPE HATCH — REMOVABLE POST-LAUNCH (B9 hybrid claim).
//
// GET /internal/qa/latest-claim-email?email=… , guarded by header X-QA-Secret
// matching env QA_SECRET. Returns the most recent claim-email contents (the
// 6-digit code + approve link) for that email, stored in qa_claim_emails only
// when QA_SECRET is set (see app/agent/identity/route.ts and
// app/agent/identity/claim/route.ts). Reviewers depend on this to complete the
// email-mode claim flow programmatically (the code is hashed everywhere else).
//
// To remove: unset QA_SECRET (disables the writes AND 404s this endpoint), then
// delete app/internal/qa/ and drop the qa_claim_emails table.

function secretOk(provided: string | null): boolean {
  const expected = process.env.QA_SECRET;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(req: Request): Promise<Response> {
  if (!process.env.QA_SECRET) return json({ error: "not_found" }, 404);
  if (!secretOk(req.headers.get("x-qa-secret"))) return json({ error: "forbidden" }, 403);

  const url = new URL(req.url);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email) return json({ error: "invalid_request", message: "email required" }, 400);

  const { rows } = await query<{ code: string; approve_link: string; created_at: string }>(
    `SELECT code, approve_link, created_at FROM qa_claim_emails
     WHERE email = $1
     ORDER BY created_at DESC LIMIT 1`,
    [email]
  );
  if (!rows[0]) return json({ error: "no_email", email }, 404);

  return json(
    {
      email,
      code: rows[0].code,
      approve_link: rows[0].approve_link,
      created_at: rows[0].created_at,
    },
    200
  );
}
