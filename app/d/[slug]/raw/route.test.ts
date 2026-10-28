import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findBySlug: vi.fn(),
  canViewSession: vi.fn(),
  verifyViewCap: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/lib/docs/store", () => ({ findBySlug: mocks.findBySlug }));
vi.mock("@/lib/docs/access", () => ({ canViewSession: mocks.canViewSession }));
vi.mock("@/lib/docs/viewcap", () => ({ verifyViewCap: mocks.verifyViewCap }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));

import { GET } from "@/app/d/[slug]/raw/route";

const FONTLESS_DOC = `<!doctype html><html><head><title>x</title></head><body><p>plain</p></body></html>`;
const STYLED_DOC = `<!doctype html><html><head><style>body{font-family:Georgia}</style></head><body><p>fancy</p></body></html>`;

function doc(html: string) {
  return { id: 1, slug: "a-doc", html, is_public: true, title: null, version: 1 };
}

async function get(url: string) {
  const res = await GET(new Request(url), { params: Promise.resolve({ slug: "a-doc" }) });
  return { status: res.status, html: await res.text() };
}

describe("GET /d/:slug/raw", () => {
  beforeEach(() => {
    mocks.findBySlug.mockReset();
    mocks.canViewSession.mockReset().mockResolvedValue(true);
    mocks.getSession.mockReset().mockResolvedValue(null);
  });

  it("serves byte-pristine HTML on a direct fetch — no overlay, no injected font", async () => {
    mocks.findBySlug.mockResolvedValue(doc(FONTLESS_DOC));
    const { status, html } = await get("https://justhtml.sh/d/a-doc/raw");
    expect(status).toBe(200);
    expect(html).toBe(FONTLESS_DOC);
  });

  it("injects the default sans font for a fontless doc in the shell variant", async () => {
    mocks.findBySlug.mockResolvedValue(doc(FONTLESS_DOC));
    const { html } = await get("https://justhtml.sh/d/a-doc/raw?overlay=1");
    expect(html).toContain('data-jh-default-font="1"');
    expect(html).toContain("-apple-system");
    expect(html.indexOf('data-jh-default-font')).toBeLessThan(html.toLowerCase().lastIndexOf("</body>"));
  });

  it("leaves a doc that declares its own font untouched in the shell variant", async () => {
    mocks.findBySlug.mockResolvedValue(doc(STYLED_DOC));
    const { html } = await get("https://justhtml.sh/d/a-doc/raw?overlay=1");
    expect(html).not.toContain("data-jh-default-font");
    expect(html).toContain("font-family:Georgia");
  });
});
