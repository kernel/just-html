import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommentsShell from "./CommentsShell";

const props = {
  slug: "test doc",
  title: "Test doc",
  rawSrc: "/d/test-doc/raw",
  viewtoken: null,
  canComment: false,
  canReact: false,
  canEdit: false,
  signedIn: false,
  docId: 1,
  bookmarked: false,
  me: null,
  initialThreads: [],
  initialDocReactions: [],
  initialAnchoredReactions: [],
  initialSections: [],
  version: 1,
  initialTheme: null,
};

let hidden = false;
let reload: ReturnType<typeof vi.fn>;
let renderer: ReactTestRenderer | null;

function response(version: string) {
  return { ok: true, text: async () => version } as Response;
}

async function renderShell() {
  await act(async () => {
    renderer = create(<CommentsShell {...props} />);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  reload = vi.fn();
  renderer = null;

  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", {
    get hidden() {
      return hidden;
    },
  });
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  });
  vi.stubGlobal("window", {
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    location: { origin: "https://justhtml.test", hash: "", reload },
  });
});

afterEach(async () => {
  if (renderer) {
    await act(async () => renderer?.unmount());
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("document update polling", () => {
  it("does not request a version while the document is hidden", async () => {
    const fetch = vi.fn().mockResolvedValue(response("1"));
    vi.stubGlobal("fetch", fetch);
    hidden = true;
    await renderShell();

    await advance(60_000);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("requests the version once every 30 seconds while visible", async () => {
    const fetch = vi.fn().mockResolvedValue(response("1"));
    vi.stubGlobal("fetch", fetch);
    await renderShell();

    await advance(29_999);
    expect(fetch).not.toHaveBeenCalled();
    await advance(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not overlap version requests", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve)));
    vi.stubGlobal("fetch", fetch);
    await renderShell();

    await advance(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => resolveFetch?.(response("1")));
    await advance(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled request and retries on the next interval", async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      })
    );
    vi.stubGlobal("fetch", fetch);
    await renderShell();

    await advance(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await advance(15_000);
    expect(signals[0].aborted).toBe(true);
    await advance(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts an active request when polling stops", async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      })
    );
    vi.stubGlobal("fetch", fetch);
    await renderShell();
    await advance(30_000);
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;

    await act(async () => renderer?.unmount());
    renderer = null;

    expect(signal.aborted).toBe(true);
  });

  it("shows the refresh control and stops polling after detecting a newer version", async () => {
    const fetch = vi.fn().mockResolvedValue(response("2"));
    vi.stubGlobal("fetch", fetch);
    await renderShell();

    await advance(30_000);

    const button = renderer!.root
      .findAllByType("button")
      .find((candidate) => candidate.children.includes("updated · refresh"));
    expect(button).toBeDefined();
    await advance(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => button!.props.onClick());
    expect(reload).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledWith();
  });
});
