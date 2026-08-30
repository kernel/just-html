type VersionPollingOptions = {
  url: string;
  currentVersion: () => number;
  onUpdate: () => void;
};

export function startVersionPolling({
  url,
  currentVersion,
  onUpdate,
}: VersionPollingOptions): () => void {
  let checking = false;
  let controller: AbortController | null = null;

  const checkVersion = async () => {
    if (checking || document.hidden) return;
    checking = true;
    controller = new AbortController();
    const timeout = window.setTimeout(() => controller?.abort(), 15_000);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) return;
      const version = Number(await response.text());
      if (Number.isInteger(version) && version > currentVersion()) onUpdate();
    } catch {
      return;
    } finally {
      window.clearTimeout(timeout);
      controller = null;
      checking = false;
    }
  };

  const interval = window.setInterval(() => void checkVersion(), 30_000);
  return () => {
    window.clearInterval(interval);
    controller?.abort();
  };
}
