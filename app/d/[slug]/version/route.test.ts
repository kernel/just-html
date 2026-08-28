import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findVersionBySlug: vi.fn(),
  canViewSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/lib/docs/store", () => ({ findVersionBySlug: mocks.findVersionBySlug }));
vi.mock("@/lib/docs/access", () => ({ canViewSession: mocks.canViewSession }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));

import { GET } from "@/app/d/[slug]/version/route";

const doc = {
  id: 1,
  owner_id: 2,
  is_public: false,
  view_token: "secret-token",
  version: 7,
};

function request(viewtoken?: string) {
  const query = viewtoken ? `?viewtoken=${viewtoken}` : "";
  return new Request(`https://justhtml.sh/d/quiet-moon-12345/version${query}`);
}

const ctx = { params: Promise.resolve({ slug: "quiet-moon-12345" }) };

describe("document version", () => {
  beforeEach(() => {
    mocks.findVersionBySlug.mockResolvedValue(doc);
    mocks.getSession.mockResolvedValue(null);
    mocks.canViewSession.mockResolvedValue(true);
  });

  it("returns the current version without caching", async () => {
    const res = await GET(request("secret-token"), ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("7");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.canViewSession).toHaveBeenCalledWith(doc, null, "secret-token");
  });

  it("does not distinguish missing and unauthorized documents", async () => {
    mocks.findVersionBySlug.mockResolvedValueOnce(null);
    const missing = await GET(request(), ctx);

    mocks.canViewSession.mockResolvedValueOnce(false);
    const unauthorized = await GET(request(), ctx);

    expect(missing.status).toBe(404);
    expect(unauthorized.status).toBe(404);
    expect(await missing.text()).toBe("");
    expect(await unauthorized.text()).toBe("");
  });
});
