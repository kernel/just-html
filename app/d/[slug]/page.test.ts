import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findBySlug: vi.fn(),
  canViewSession: vi.fn(),
  canView: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/lib/docs/store", () => ({ findBySlug: mocks.findBySlug, bookmarkExists: vi.fn() }));
vi.mock("@/lib/docs/access", () => ({
  canViewSession: mocks.canViewSession,
  canView: mocks.canView,
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/docs/grants", () => ({ canEdit: vi.fn() }));
vi.mock("@/lib/docs/viewcap", () => ({ mintViewCap: vi.fn() }));
vi.mock("@/lib/docs/comments", () => ({
  resolveCommentPrincipal: vi.fn(),
  resolveCapability: vi.fn(),
  allThreads: vi.fn(),
}));
vi.mock("@/lib/docs/theme", () => ({ detectServerTheme: vi.fn() }));
vi.mock("@/lib/docs/sections", () => ({ extractSections: vi.fn() }));
vi.mock("@/app/d/[slug]/CommentsShell", () => ({ default: vi.fn() }));

import { generateMetadata } from "@/app/d/[slug]/page";

const doc = {
  id: 1,
  slug: "quiet-moon-12345",
  owner_id: 1,
  title: "Private plan",
  html: `<meta name="description" content="Private preview copy">`,
  version: 1,
  is_public: false,
  view_token: "secret-token",
  created_at: "2026-08-28T00:00:00Z",
  updated_at: "2026-08-28T00:00:00Z",
  deleted_at: null,
};

function props(viewtoken?: string) {
  return {
    params: Promise.resolve({ slug: doc.slug }),
    searchParams: Promise.resolve(viewtoken ? { viewtoken } : {}),
  };
}

describe("document metadata", () => {
  beforeEach(() => {
    mocks.findBySlug.mockResolvedValue(doc);
    mocks.getSession.mockResolvedValue(null);
    mocks.canViewSession.mockResolvedValue(false);
    mocks.canView.mockReturnValue(false);
  });

  it("does not disclose private metadata for a bare document URL", async () => {
    const metadata = await generateMetadata(props());
    expect(metadata.title).toBe("justhtml.sh");
    expect(metadata.description).toBeUndefined();
    expect(metadata.openGraph).toBeUndefined();
    expect(metadata.twitter).toBeUndefined();
  });

  it("adds rich metadata when a view token authorizes the page and image", async () => {
    mocks.canViewSession.mockResolvedValue(true);
    mocks.canView.mockReturnValue(true);
    const metadata = await generateMetadata(props("secret-token"));

    expect(metadata.title).toBe("Private plan — justhtml.sh");
    expect(metadata.description).toBe("Private preview copy");
    expect(metadata.openGraph).toMatchObject({
      title: "Private plan",
      description: "Private preview copy",
      siteName: "justhtml.sh",
      url: `https://justhtml.sh/d/${doc.slug}?viewtoken=secret-token`,
    });
    expect(metadata.openGraph?.images).toEqual([
      expect.objectContaining({
        url: `https://justhtml.sh/d/${doc.slug}/preview?viewtoken=secret-token`,
        width: 1200,
        height: 630,
      }),
    ]);
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image", title: "Private plan" });
  });

  it("does not mint an image URL for session-only private access", async () => {
    mocks.getSession.mockResolvedValue({ id: 1, email: "owner@example.com", user_id: 1 });
    mocks.canViewSession.mockResolvedValue(true);
    const metadata = await generateMetadata(props());

    expect(metadata.openGraph?.images).toBeUndefined();
    expect(metadata.twitter).toMatchObject({ card: "summary", images: undefined });
  });

  it("adds a token-free image for a public document", async () => {
    mocks.findBySlug.mockResolvedValue({ ...doc, is_public: true });
    mocks.canViewSession.mockResolvedValue(true);
    const metadata = await generateMetadata(props());

    expect(metadata.robots).toBeUndefined();
    expect(metadata.openGraph?.images).toEqual([
      expect.objectContaining({ url: `https://justhtml.sh/d/${doc.slug}/preview` }),
    ]);
  });
});
