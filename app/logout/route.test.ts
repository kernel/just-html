import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/auth/tokens";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: mocks.query }));

import { POST } from "@/app/logout/route";

function request(cookie?: string, origin = "https://justhtml.sh"): Request {
  const headers = new Headers({ origin });
  if (cookie) headers.set("cookie", cookie);
  return new Request("https://justhtml.sh/logout", { method: "POST", headers });
}

describe("POST /logout", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [] });
  });

  it("revokes the session, clears the cookie, and redirects to login", async () => {
    const res = await POST(request("other=value; jh_sess=sess_test"));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("set-cookie")).toBe(
      "jh_sess=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE sessions SET revoked_at = now()"),
      [sha256Hex("sess_test")]
    );
  });

  it("still clears a stale or missing session cookie", async () => {
    const res = await POST(request());

    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests", async () => {
    const res = await POST(request("jh_sess=sess_test", "https://example.com"));

    expect(res.status).toBe(403);
    expect(res.headers.has("set-cookie")).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
