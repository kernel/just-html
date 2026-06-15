// Adaptive chrome — VARIANT D palette derivation (founder-approved 2026-06-12,
// design/adaptive-chrome-demo/index.html). Pure color math, shared by BOTH the
// client (CommentsShell applies it from the overlay's jh:theme message) and the
// server (page.tsx derives a coarse SSR theme from the stored HTML so the bar is
// themed before any JS runs — no light→dark flash).
//
// The ONLY thing that can read the document's *computed* colors is the overlay
// running inside the sandboxed origin-less iframe (the shell can't reach across
// the opaque origin). The overlay samples bg/fg/accent and posts jh:theme; this
// module turns those samples into a full chrome palette.
//
// SCOPE: re-coloring only. LIGHT documents keep today's EXACT light chrome
// (#fff bar / #ccc border / #fbfbfb rail …) — those literals live in the shell,
// not here; this module is consulted only when isDark. The door is kept open for
// a future user toggle by gating application on a single `mode` that is always
// "auto" today.

export type ThemeSample = {
  bg: string; // documentElement (or body) background color — any CSS color string
  fg: string; // body/documentElement text color
  accent?: string; // representative link/heading color, if any
  isDark: boolean; // decided by the overlay (WCAG luminance + hysteresis)
  // True when bg is a gradient/image (backgroundColor transparent but a
  // backgroundImage exists) — we can't promise a seamless bar, so we still derive
  // a dark palette from a best-effort sample but the caller treats the bar as an
  // honest solid (no seamless claim). Purely informational for now.
  gradient?: boolean;
};

// The full set of chrome surface values variant D drives. Mirrors the CSS-var
// names in the demo so the mapping is auditable 1:1. Only consumed when dark.
export type ChromePalette = {
  // top bar
  barBg: string;
  barBorder: string;
  barFg: string;
  barMuted: string;
  // 💬 toggle (idle + active)
  togBorder: string;
  togBg: string;
  togFg: string;
  togOnBorder: string;
  togOnBg: string;
  togOnFg: string;
  // stage / rail
  stageBg: string;
  railBg: string;
  railBorder: string;
  railLine: string;
  railMuted: string;
  railFaint: string;
  // cards
  cardBg: string;
  cardBorder: string;
  cardShadow: string;
  cardPinBorder: string;
  cardPinShadow: string;
  cardOrphanBorder: string;
  cardFg: string;
  cardMuted: string;
  cardFaint: string;
  cardLine: string;
  cardLine2: string;
  // avatars / sub-surfaces
  avatarRing: string;
  avatarBg: string;
  replyBg: string;
  composerBg: string;
  // inputs / buttons
  inputBorder: string;
  inputBg: string;
  btnBorder: string;
  btnBg: string;
  btnFg: string;
  // reaction chips
  chipBorder: string;
  chipBg: string;
  chipMineBorder: string;
  chipMineBg: string;
  chipMineFg: string;
  // badges
  badgeResBg: string;
  badgeResFg: string;
  badgeOrpBg: string;
  badgeOrpFg: string;
  // selection toolbar
  selBg: string;
  selBorder: string;
  selFg: string;
  selShadow: string;
  selHover: string;
  // comment highlight wash (painted INSIDE the iframe by the overlay; exported so
  // both sides agree). Yellow → translucent warm wash + warm ring on dark.
  hlBg: string;
  hlFg: string;
  hlRing: string;
  // mobile drawer + scrim
  scrimBg: string;
  drawerShadow: string;
};

// ----------------------------- color math -----------------------------
// Ported verbatim from the demo's builders. Inputs are normalized to #rrggbb
// hex first (parseColor accepts hex, rgb()/rgba(), and a few keywords) so the
// hex-based helpers below are exact.

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function toHex2(v: number): string {
  return clamp255(v).toString(16).padStart(2, "0");
}

/** Parse a CSS color into [r,g,b] (0..255) or null if transparent/unknown. */
export function parseColor(input: string | null | undefined): [number, number, number] | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (s === "transparent") return null;
  // rgb()/rgba() — fully transparent alpha ⇒ treat as no color.
  const m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.%]+))?\s*\)$/);
  if (m) {
    const a = m[4];
    if (a != null) {
      const av = a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
      if (av === 0) return null;
    }
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  }
  if (s === "white") return [255, 255, 255];
  if (s === "black") return [0, 0, 0];
  // hex
  s = s.replace(/^#/, "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (s.length === 6 && /^[0-9a-f]{6}$/.test(s)) {
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  return null;
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + toHex2(r) + toHex2(g) + toHex2(b);
}

/** Normalize any CSS color to #rrggbb; falls back to `fallback` if unparseable. */
export function normHex(input: string | null | undefined, fallback: string): string {
  const c = parseColor(input);
  return c ? rgbToHex(c[0], c[1], c[2]) : fallback;
}

/** WCAG relative luminance of a hex color (0..1). */
export function relLum(hex: string): number {
  const rgb = parseColor(hex) ?? [255, 255, 255];
  const c = rgb.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function isDarkColor(hex: string): boolean {
  return relLum(hex) < 0.4;
}

export function contrast(a: string, b: string): number {
  const l1 = relLum(a),
    l2 = relLum(b);
  const hi = Math.max(l1, l2),
    lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Lighten toward white (dark bg) or darken toward black (light bg) by t (0..1). */
export function lift(hex: string, t: number): string {
  const rgb = parseColor(hex) ?? [0, 0, 0];
  const target = isDarkColor(hex) ? 255 : 0;
  return rgbToHex(
    rgb[0] + (target - rgb[0]) * t,
    rgb[1] + (target - rgb[1]) * t,
    rgb[2] + (target - rgb[2]) * t
  );
}

export function rgba(hex: string, a: number): string {
  const rgb = parseColor(hex) ?? [0, 0, 0];
  return `rgba(${clamp255(rgb[0])},${clamp255(rgb[1])},${clamp255(rgb[2])},${a})`;
}

/** Nudge fg toward full contrast vs bg until it passes `target` (AA = 4.5). */
export function ensure(fg: string, bg: string, target: number): string {
  let c = fg;
  let i = 0;
  while (contrast(c, bg) < target && i < 24) {
    c = lift(c, 0.06);
    i++;
  }
  return c;
}

// --------------------------- variant D builder ---------------------------

/**
 * VARIANT D — SYNTHESIS. Seamless bar/rail (= doc bg, like A), ONE elevation step
 * for cards (+9%, like B), accent from the doc's link used sparingly: toggle-
 * active, links, focus ring, "mine" chip (like C). Contrast-guarded throughout.
 *
 * Only meaningful when the doc is dark. `fg`/`accent` may be unparseable or
 * missing; we fall back to sensible defaults so the palette is always complete.
 */
export function buildChromePalette(sample: ThemeSample): ChromePalette {
  const bg = normHex(sample.bg, "#0d1117");
  // base fg, AA-guarded vs bg; default to a light gray if unparseable.
  const fg = ensure(normHex(sample.fg, "#c9d1d9"), bg, 4.5);
  const card = lift(bg, 0.09);
  const muted = rgba(fg, 0.62);

  // accent: AA-guarded sampled link; if no usable accent, fall back to fg (so the
  // few accented elements stay legible rather than vanishing — variant D "fall
  // back if the sampled link is unusable").
  const accentRaw = sample.accent ? parseColor(sample.accent) : null;
  const accent = accentRaw ? ensure(rgbToHex(accentRaw[0], accentRaw[1], accentRaw[2]), bg, 4.5) : fg;
  const accentText = contrast("#0b0b0b", accent) > contrast("#fff", accent) ? "#0b0b0b" : "#fff";

  return {
    barBg: bg,
    barBorder: rgba(fg, 0.13),
    barFg: fg,
    barMuted: muted,

    togBorder: rgba(fg, 0.22),
    togBg: lift(bg, 0.06),
    togFg: fg,
    togOnBorder: accent,
    togOnBg: accent,
    togOnFg: accentText,

    stageBg: bg,
    railBg: bg,
    railBorder: rgba(fg, 0.13),
    railLine: rgba(fg, 0.09),
    railMuted: muted,
    railFaint: rgba(fg, 0.45),

    cardBg: card,
    cardBorder: rgba(fg, 0.11),
    cardShadow: "0 1px 2px rgba(0,0,0,.35)",
    cardPinBorder: accent,
    cardPinShadow: `0 0 0 1px ${rgba(accent, 0.45)}, 0 4px 16px rgba(0,0,0,.5)`,
    cardOrphanBorder: rgba("#f1948a", 0.55),
    cardFg: fg,
    cardMuted: muted,
    cardFaint: rgba(fg, 0.4),
    cardLine: rgba(fg, 0.08),
    cardLine2: rgba(fg, 0.06),

    avatarRing: rgba(fg, 0.18),
    avatarBg: lift(bg, 0.14),
    replyBg: lift(bg, 0.05),
    composerBg: lift(bg, 0.06),

    inputBorder: rgba(fg, 0.2),
    inputBg: lift(bg, 0.04),
    btnBorder: accent,
    btnBg: accent,
    btnFg: accentText,

    chipBorder: rgba(fg, 0.16),
    chipBg: lift(bg, 0.12),
    chipMineBorder: accent,
    chipMineBg: rgba(accent, 0.2),
    chipMineFg: accent,

    badgeResBg: rgba("#5fb37a", 0.2),
    badgeResFg: "#8fdca8",
    badgeOrpBg: rgba("#e06c6c", 0.2),
    badgeOrpFg: "#f1948a",

    selBg: lift(bg, 0.12),
    selBorder: rgba(fg, 0.16),
    selFg: fg,
    selShadow: "rgba(0,0,0,.55)",
    selHover: rgba(accent, 0.22),

    // yellow comment highlight → translucent warm wash + warm ring; text stays doc fg.
    hlBg: rgba("#f1c40f", 0.2),
    hlFg: "inherit",
    hlRing: rgba("#f1c40f", 0.55),

    scrimBg: "rgba(0,0,0,.55)",
    drawerShadow: "rgba(0,0,0,.6)",
  };
}

// --------------------------- server-side coarse detection ---------------------------

/**
 * Conservatively parse an UNCONDITIONAL html/body background color out of stored
 * doc HTML so the server can theme the bar/stage at SSR (PlainShell has no JS;
 * CommentsShell uses it as the initial theme to avoid a light→dark flash before
 * jh:theme arrives).
 *
 * Conservative by design — the overlay confirms later when JS runs:
 *  - Only inline style="background…" on <html>/<body>, OR a CSS rule for
 *    html/body/:root with an unconditional background color.
 *  - A background that is dark ONLY under @media (prefers-color-scheme: dark) is
 *    "unknown" → default light. We strip all @media blocks before scanning.
 *  - <meta name="color-scheme" content="dark"> (or a CSS `color-scheme: dark`)
 *    with no explicit bg is treated as a hint, but we still require a real dark
 *    color to flip; a bare hint alone stays light (avoid mis-theming).
 *  - On any ambiguity → light (returns null).
 *
 * Returns a ThemeSample when it is confident the doc is dark; otherwise null
 * (caller renders today's light chrome).
 */
export function detectServerTheme(html: string): ThemeSample | null {
  if (!html) return null;
  const head = html.slice(0, 200_000); // bound work on huge docs

  // Drop @media blocks (incl. prefers-color-scheme) so we only read
  // unconditional rules. Best-effort brace matching for top-level @media.
  const unconditional = stripAtMediaBlocks(head);

  let bg: string | null = null;
  let fg: string | null = null;
  let accent: string | null = null;

  // 1) inline style on <html ...> / <body ...>
  bg = inlineBgFromTag(unconditional, "html") ?? inlineBgFromTag(unconditional, "body");
  fg = inlineColorFromTag(unconditional, "body") ?? inlineColorFromTag(unconditional, "html");

  // 2) CSS rules in <style> for html / body / :root
  const css = extractStyleBlocks(unconditional);
  if (!bg) bg = cssBgForSelectors(css, ["html", "body", ":root"]);
  if (!fg) fg = cssColorForSelectors(css, ["body", "html", ":root"]);
  accent = cssColorForSelectors(css, ["a", "a:link", "h1", "h2", "h3"]);

  const bgHex = bg ? normHex(bg, "") : "";
  if (!bgHex) return null; // no confident unconditional bg → light
  if (!isDarkColor(bgHex)) return null; // light bg → light chrome

  return {
    bg: bgHex,
    fg: fg ? normHex(fg, "#c9d1d9") : "#c9d1d9",
    accent: accent ? normHex(accent, "") || undefined : undefined,
    isDark: true,
  };
}

function stripAtMediaBlocks(s: string): string {
  let out = "";
  let i = 0;
  const lower = s.toLowerCase();
  while (i < s.length) {
    const at = lower.indexOf("@media", i);
    if (at === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, at);
    // find the opening brace of the @media block
    const brace = s.indexOf("{", at);
    if (brace === -1) {
      // malformed; bail to avoid infinite loop
      out += s.slice(at);
      break;
    }
    // skip balanced braces
    let depth = 1;
    let j = brace + 1;
    while (j < s.length && depth > 0) {
      const ch = s[j];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    i = j;
  }
  return out;
}

function extractStyleBlocks(s: string): string {
  const blocks: string[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) blocks.push(m[1]);
  return blocks.join("\n");
}

function inlineBgFromTag(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\bstyle\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = html.match(re);
  if (!m) return null;
  const style = m[2] ?? m[3] ?? "";
  return bgFromDeclList(style);
}

function inlineColorFromTag(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\bstyle\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = html.match(re);
  if (!m) return null;
  const style = m[2] ?? m[3] ?? "";
  return colorFromDeclList(style);
}

function bgFromDeclList(decls: string): string | null {
  // background-color: X  OR  background: X (take the first color token)
  const bc = decls.match(/background-color\s*:\s*([^;]+)/i);
  if (bc && parseColor(bc[1].trim())) return bc[1].trim();
  const bg = decls.match(/background\s*:\s*([^;]+)/i);
  if (bg) {
    // skip gradients/urls — not a flat color we can match.
    const v = bg[1].trim();
    if (/gradient|url\s*\(/i.test(v)) return null;
    // first whitespace-separated token that parses as a color
    for (const tok of v.split(/\s+/)) {
      if (parseColor(tok)) return tok;
    }
  }
  return null;
}

function colorFromDeclList(decls: string): string | null {
  // `color:` but not `background-color:`/`border-color:` etc. Match start or `;`.
  const m = decls.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
  if (m && parseColor(m[1].trim())) return m[1].trim();
  return null;
}

function ruleBodyFor(css: string, selector: string): string | null {
  // Find a rule whose selector list contains `selector` as a standalone token.
  // Scan rule by rule (selector { body }). Conservative: first match wins.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  const sel = selector.toLowerCase();
  while ((m = re.exec(css))) {
    const selectors = m[1]
      .toLowerCase()
      .split(",")
      .map((x) => x.trim());
    if (selectors.includes(sel)) return m[2];
  }
  return null;
}

function cssBgForSelectors(css: string, selectors: string[]): string | null {
  for (const sel of selectors) {
    const body = ruleBodyFor(css, sel);
    if (body) {
      const c = bgFromDeclList(body);
      if (c) return c;
    }
  }
  return null;
}

function cssColorForSelectors(css: string, selectors: string[]): string | null {
  for (const sel of selectors) {
    const body = ruleBodyFor(css, sel);
    if (body) {
      const c = colorFromDeclList(body);
      if (c) return c;
    }
  }
  return null;
}
