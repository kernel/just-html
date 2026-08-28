import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findVersionBySlug: vi.fn(),
  canViewSession: vi.fn(),
  getSessionReadOnly: vi.fn(),
}));

vi.mock("@/lib/docs/store", () => ({ findVersionBySlug: mocks.findVersionBySlug }));
vi.mock("@/lib/docs/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docs/access")>()),
  canViewSession: mocks.canViewSession,
}));
vi.mock("@/lib/auth/session", () => ({ getSessionReadOnly: mocks.getSessionReadOnly }));

import { GET } from "@/app/d/[slug]/version/route";

const doc = {
  id: 1,
  owner_id: 2,
  is_public: false,
  view_token: "secret-token",
  version: 7,
};

const session = { id: 3, email: "viewer@example.com", user_id: 4 };

function request(viewtoken?: string) {
  const query = viewtoken ? `?viewtoken=${viewtoken}` : "";
  return new Request(`https://justhtml.sh/d/quiet-moon-12345/version${query}`);
}

const ctx = { params: Promise.resolve({ slug: "quiet-moon-12345" }) };

describe("document version", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findVersionBySlug.mockResolvedValue(doc);
    mocks.getSessionReadOnly.mockResolvedValue(session);
    mocks.canViewSession.mockResolvedValue(true);
  });

  it("returns the current version without caching", async () => {
    const res = await GET(request(), ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("7");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.getSessionReadOnly).toHaveBeenCalledOnce();
    expect(mocks.canViewSession).toHaveBeenCalledWith(doc, session, null);
  });

  it("skips session resolution for a valid view token", async () => {
    const res = await GET(request("secret-token"), ctx);

    expect(res.status).toBe(200);
    expect(mocks.getSessionReadOnly).not.toHaveBeenCalled();
    expect(mocks.canViewSession).not.toHaveBeenCalled();
  });

  it("skips session resolution for a public document", async () => {
    mocks.findVersionBySlug.mockResolvedValueOnce({ ...doc, is_public: true });

    const res = await GET(request(), ctx);

    expect(res.status).toBe(200);
    expect(mocks.getSessionReadOnly).not.toHaveBeenCalled();
    expect(mocks.canViewSession).not.toHaveBeenCalled();
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
