import { authenticate, unauthorized } from "@/lib/auth/bearer";

export const dynamic = "force-dynamic";

// GET /api/v1/docs — B2 stub. The full docs CRUD lands in B3; for B2 this
// exists so the API 401 contract (WWW-Authenticate, §3.5) is real and so the
// auth.md "harmless authenticated request" key-validation probe
// (GET /api/v1/docs?limit=1) succeeds with a valid key. A valid key returns an
// empty list; everything else returns the spec'd 401 with the discovery hint.
export async function GET(req: Request): Promise<Response> {
  const principal = await authenticate(req);
  if (!principal) {
    return unauthorized(
      req.headers.get("authorization")
        ? "Invalid, expired, or revoked credential."
        : "Missing Bearer credential."
    );
  }
  return new Response(JSON.stringify({ docs: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
