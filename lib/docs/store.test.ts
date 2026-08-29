import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  clientQuery: vi.fn(),
  invalidateDocVersion: vi.fn(),
  query: vi.fn(),
  reanchorComments: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getPool: () => ({ connect: mocks.connect }),
  query: mocks.query,
}));
vi.mock("@/lib/docs/reanchor", () => ({ reanchorComments: mocks.reanchorComments }));
vi.mock("@/lib/docs/version-cache", () => ({
  invalidateDocVersion: mocks.invalidateDocVersion,
}));

import {
  applyPatch,
  rewriteDoc,
  rotateViewToken,
  softDelete,
  updateMeta,
  type DocRow,
} from "@/lib/docs/store";

const doc: DocRow = {
  id: 1,
  slug: "quiet-moon-12345",
  owner_id: 2,
  title: "Test",
  html: "<p>old</p>",
  version: 1,
  is_public: false,
  view_token: "token",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
};

function setupTransaction() {
  mocks.clientQuery.mockImplementation(async (text: string) => {
    if (text.includes("SELECT * FROM documents")) return { rows: [doc] };
    if (text.includes("AS other_bytes")) {
      return { rows: [{ other_bytes: 0, this_versions_bytes: 0 }] };
    }
    if (text.includes("UPDATE documents SET html")) {
      return { rows: [{ ...doc, html: "<p>new</p>", version: 2 }] };
    }
    return { rows: [] };
  });
}

describe("document version cache invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({
      query: mocks.clientQuery,
      release: mocks.release,
    });
    setupTransaction();
  });

  it.each([
    [
      "full rewrites",
      () => rewriteDoc({ doc, html: "<p>new</p>", authorUserId: 2 }),
    ],
    [
      "patches",
      () =>
        applyPatch({
          doc,
          edits: [{ oldText: "old", newText: "new" }],
          baseVersion: 1,
          authorUserId: 2,
        }),
    ],
  ])("invalidates after %s", async (_name, mutate) => {
    await mutate();

    const commitCall = mocks.clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    expect(commitCall).toBeGreaterThanOrEqual(0);
    expect(mocks.invalidateDocVersion).toHaveBeenCalledWith(doc.slug);
    expect(mocks.invalidateDocVersion.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.clientQuery.mock.invocationCallOrder[commitCall]
    );
  });

  it.each([
    ["metadata updates", () => updateMeta({ docId: doc.id, isPublic: true })],
    ["token rotations", () => rotateViewToken(doc.id)],
    ["deletion", () => softDelete(doc.id)],
  ])("invalidates after %s", async (_name, mutate) => {
    mocks.query.mockResolvedValue({ rows: [doc] });

    await mutate();

    expect(mocks.invalidateDocVersion).toHaveBeenCalledWith(doc.slug);
  });

  it("does not invalidate an already-deleted document", async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    await softDelete(doc.id);

    expect(mocks.invalidateDocVersion).not.toHaveBeenCalled();
  });
});
