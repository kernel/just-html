import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({ query: mocks.query }));

import { getSessionReadOnly } from "@/lib/auth/session";

function request() {
  return new Request("https://justhtml.sh/d/test/version", {
    headers: { cookie: "jh_sess=sess_test-token" },
  });
}

describe("getSessionReadOnly", () => {
  beforeEach(() => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: 1,
          email: "viewer@example.com",
          user_id: 2,
          last_seen_at: "2000-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("validates expiry and revocation without renewing the session", async () => {
    await expect(getSessionReadOnly(request())).resolves.toEqual({
      id: 1,
      email: "viewer@example.com",
      user_id: 2,
    });

    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0][0]).toContain("revoked_at IS NULL AND expires_at > now()");
    expect(mocks.query.mock.calls[0][0]).not.toContain("UPDATE sessions");
  });
});
