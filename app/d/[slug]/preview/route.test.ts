import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findBySlug: vi.fn(),
  canView: vi.fn(),
  clientIp: vi.fn(),
  checkLimits: vi.fn(),
}));

vi.mock("@/lib/docs/store", () => ({ findBySlug: mocks.findBySlug }));
vi.mock("@/lib/docs/access", () => ({ canView: mocks.canView }));
vi.mock("@/lib/auth/request", () => ({ clientIp: mocks.clientIp }));
vi.mock("@/lib/auth/ratelimit", () => ({ checkLimits: mocks.checkLimits }));
vi.mock("next/og", () => ({
  ImageResponse: class extends Response {
    constructor(_element: unknown, options: { headers?: HeadersInit } = {}) {
      super("png", { status: 200, headers: { "Content-Type": "image/png", ...options.headers } });
    }
  },
}));

import { GET } from "@/app/d/[slug]/preview/route";

const doc = {
  id: 1,
  slug: "quiet-moon-12345",
  owner_id: 1,
  title: "Private plan",
  html: `<meta name="description" content="The plan">`,
  version: 1,
  is_public: false,
  view_token: "secret-token",
  created_at: "2026-08-28T00:00:00Z",
  updated_at: "2026-08-28T00:00:00Z",
  deleted_at: null,
};

function request(query = "") {
  return GET(new Request(`https://justhtml.sh/d/${doc.slug}/preview${query}`), {
    params: Promise.resolve({ slug: doc.slug }),
  });
}

describe("GET /d/:slug/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findBySlug.mockResolvedValue(doc);
    mocks.canView.mockReturnValue(false);
    mocks.clientIp.mockReturnValue("192.0.2.10");
    mocks.checkLimits.mockResolvedValue(null);
  });

  it("rate limits image rendering by viewer IP", async () => {
    mocks.checkLimits.mockResolvedValue({ retryAfter: 37 });
    const res = await request("?viewtoken=secret-token");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("37");
    expect(mocks.findBySlug).not.toHaveBeenCalled();
  });

  it("does not expose a private document preview without a valid view token", async () => {
    const res = await request();
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("renders a private preview authorized by its own URL", async () => {
    mocks.canView.mockReturnValue(true);
    const res = await request("?viewtoken=secret-token");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noimageindex");
  });

  it("allows public previews to be cached briefly", async () => {
    mocks.findBySlug.mockResolvedValue({ ...doc, is_public: true });
    mocks.canView.mockReturnValue(true);
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
  });
});
