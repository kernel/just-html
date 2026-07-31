// Read time for the viewer chrome bar.
//
// The count itself comes from the overlay: only inside the sandboxed iframe, against
// a laid-out DOM, can we tell what the reader actually SEES on first load — a tab
// panel hidden by a class in a <style> block, a closed <details>, an unopened dialog.
// A server-side pass over the stored HTML would count all of it, so there is no
// server estimate at all; the chip appears once the overlay reports (jh:readtime),
// and a doc whose overlay never runs simply has no chip.
//
// The overlay walks the DOM and posts raw {words, cjk}; everything downstream of that
// — the rate, the rounding, the thresholds — lives here, where it is testable and
// shared by the shell.

const WORDS_PER_MINUTE = 200;
// CJK scripts are written without spaces, so whitespace tokens undercount them by an
// order of magnitude. The overlay counts those characters individually and we charge
// them at a per-character rate.
const CJK_PER_MINUTE = 500;

/**
 * Minutes to read, rounded up (so any prose at all is at least "1 min read"). Returns
 * 0 when there is nothing to read — an image-only doc — and the bar then shows no chip
 * rather than claiming a minute.
 */
export function readMinutesFor(words: number, cjk: number): number {
  if (words <= 0 && cjk <= 0) return 0;
  return Math.ceil(words / WORDS_PER_MINUTE + cjk / CJK_PER_MINUTE);
}

// A shared doc should be a short read; the chip's fill gets heavier as the estimate
// grows. Under 5 minutes reads as fine, up to 15 as getting long, past 15 as "this
// should probably be two docs".
export type ReadLevel = "ok" | "warn" | "over";

const WARN_FROM = 5;
const OVER_ABOVE = 15;

export function readTimeLevel(minutes: number): ReadLevel {
  if (minutes < WARN_FROM) return "ok";
  if (minutes <= OVER_ABOVE) return "warn";
  return "over";
}

/**
 * The chip's tooltip — the estimate in words, since the fill color alone is no use to
 * a screen reader, plus what the heaviest fill is complaining about.
 */
export function readTimeTitle(minutes: number): string {
  const plural = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const suffix = readTimeLevel(minutes) === "over" ? " — long for a shared doc" : "";
  return `Estimated read time: ${plural}${suffix}`;
}
