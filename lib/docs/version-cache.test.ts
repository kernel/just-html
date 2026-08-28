import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  revalidateTag: vi.fn(),
  unstableCache: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ query: mocks.query }));
vi.mock("next/cache", () => ({
  revalidateTag: mocks.revalidateTag,
  unstable_cache: mocks.unstableCache,
}));

import { findVersionBySlug, invalidateDocVersion } from "@/lib/docs/version-cache";

const doc = { id: 1, owner_id: 2, is_public: false, view_token: "token", version: 7 };

describe("document version cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.unstableCache.mockImplementation((fn) => fn);
    mocks.query.mockResolvedValue({ rows: [doc] });
  });

  it("caches the minimal document row by slug", async () => {
    await expect(findVersionBySlug("quiet-moon-12345")).resolves.toEqual(doc);

    expect(mocks.unstableCache).toHaveBeenCalledWith(expect.any(Function), [
      "doc-version:quiet-moon-12345",
    ], {
      revalidate: 30,
      tags: ["doc-version:quiet-moon-12345"],
    });
    expect(mocks.query.mock.calls[0][0]).toContain(
      "SELECT id, owner_id, is_public, view_token, version"
    );
    expect(mocks.query.mock.calls[0][1]).toEqual(["quiet-moon-12345"]);
  });

  it("invalidates the document tag after writes", () => {
    invalidateDocVersion("quiet-moon-12345");

    expect(mocks.revalidateTag).toHaveBeenCalledWith("doc-version:quiet-moon-12345");
  });
});
