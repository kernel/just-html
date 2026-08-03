import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listDocs: vi.fn(),
  listSharedDocs: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/docs/store", () => ({
  listDocs: mocks.listDocs,
  listSharedDocs: mocks.listSharedDocs,
}));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));

import { GET } from "@/app/docs/route";

describe("GET /docs", () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({ id: 1, email: "user@example.com", user_id: 1 });
    mocks.listDocs.mockResolvedValue([]);
    mocks.listSharedDocs.mockResolvedValue([]);
  });

  it("shows a logout button for the current session", async () => {
    const res = await GET(new Request("https://justhtml.sh/docs"));
    const html = await res.text();

    expect(html).toContain('<form method="POST" action="/logout">');
    expect(html).toContain('<button type="submit">log out</button>');
  });
});
