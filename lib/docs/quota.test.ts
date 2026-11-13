import { describe, expect, it } from "vitest";
import { quotaExceeded } from "./api";
import { MAX_STORAGE_BYTES_PER_USER } from "./config";

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("quotaExceeded", () => {
  it("answers a storage cap with 413 and the numbers, not 403", async () => {
    const current = MAX_STORAGE_BYTES_PER_USER - 1024;
    const res = quotaExceeded("storage", MAX_STORAGE_BYTES_PER_USER, current);
    expect(res.status).toBe(413);
    const b = await body(res);
    expect(b.error).toBe("storage_quota_exceeded");
    expect(b.limit).toBe("storage");
    expect(b.limit_value).toBe(MAX_STORAGE_BYTES_PER_USER);
    expect(b.current).toBe(current);
    expect(b.headroom).toBe(1024);
    expect(b.suggestions).toContain("new_document");
  });

  it("says how to reclaim the space, because there is no version-delete API", async () => {
    const res = quotaExceeded("storage", MAX_STORAGE_BYTES_PER_USER, MAX_STORAGE_BYTES_PER_USER * 2);
    const b = await body(res);
    expect(String(b.message)).toContain("version-delete");
    // over the cap: headroom floors at zero rather than going negative
    expect(b.headroom).toBe(0);
  });

  it("keeps a count cap as 403 quota_exceeded", async () => {
    const res = quotaExceeded("doc_count", 500, 500);
    expect(res.status).toBe(403);
    const b = await body(res);
    expect(b.error).toBe("quota_exceeded");
    expect(b.limit).toBe("doc_count");
  });

  it("keeps a grant cap as 403 quota_exceeded", async () => {
    const res = quotaExceeded("grants", 50, 50);
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe("quota_exceeded");
  });
});
