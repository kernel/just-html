import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVersionPolling } from "@/lib/docs/version-polling";

const fetchMock = vi.fn();
let hidden = false;

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

function start(onUpdate = vi.fn()) {
  const stop = startVersionPolling({
    url: "/d/test/version?viewtoken=token",
    currentVersion: () => 1,
    onUpdate,
  });
  return { onUpdate, stop };
}

describe("version polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("1"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", {
      get hidden() {
        return hidden;
      },
    });
    vi.stubGlobal("window", {
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not request versions while the document is hidden", async () => {
    hidden = true;
    const { stop } = start();

    await advance(30_000);
    expect(fetchMock).not.toHaveBeenCalled();

    hidden = false;
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    stop();
  });

  it("reports a newer version", async () => {
    fetchMock.mockResolvedValueOnce(new Response("2"));
    const { onUpdate, stop } = start();

    await advance(30_000);

    expect(onUpdate).toHaveBeenCalledOnce();
    stop();
  });

  it("clears the interval and aborts an in-flight request", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });
    const { stop } = start();

    await advance(30_000);
    stop();

    expect(signal?.aborted).toBe(true);
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
