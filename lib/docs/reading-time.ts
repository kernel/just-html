// Estimated read time for the viewer chrome bar — a pure function of the stored
// HTML, computed at SSR alongside extractSections. Nothing is stored: an inline
// edit changes the estimate on the next load, the same as the title and the
// section list.
//
// The SSR number counts every word in the stored HTML. The overlay re-measures
// what is actually VISIBLE on first load (hidden tab panels, closed <details>)
// and posts jh:readtime; the shell prefers that. This module stays the definition
// of the rate and the thresholds — the overlay duplicates the rate constants
// because it is stringified browser JS and cannot import server code.

import { htmlToText } from "@/lib/docs/anchor";

// 200 wpm is the conventional prose estimate (Medium-style read times use the
// same ballpark). Deliberately coarse — the bar says "~how long is this", not a
// measurement.
const WORDS_PER_MINUTE = 200;

// CJK scripts are written without spaces, so whitespace tokens undercount them by
// an order of magnitude. Count those characters individually instead, charged at a
// per-character rate.
const CJK_RE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/gu;
const CJK_PER_MINUTE = 500;

// A token counts as a word only if it carries a letter or a digit, so bullets,
// rules and stray punctuation don't inflate the count.
const WORDISH = /[\p{L}\p{N}]/u;

/**
 * Minutes to read the document, rounded up (so any prose at all is at least "1
 * min read"). Returns 0 when there is no prose — an image-only or empty doc — and
 * the bar then shows nothing rather than claiming a minute.
 */
export function estimateReadMinutes(html: string): number {
  // Same masking as extractSections, plus <svg>: none of it is prose the reader
  // works through, and an inlined icon set or chart is easily thousands of
  // "words" of path data.
  const masked = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const text = htmlToText(masked);
  const cjk = (text.match(CJK_RE) ?? []).length;
  const words = text
    .replace(CJK_RE, " ")
    .split(/\s+/)
    .filter((t) => WORDISH.test(t)).length;
  if (words === 0 && cjk === 0) return 0;
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
