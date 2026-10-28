import { SANS, MONO } from "@/lib/page";

// The viewer renders each doc's own HTML in a sandboxed iframe, so a doc's
// typeface is whatever its author chose. A doc that sets no font at all falls
// back to the browser default — a serif — which reads badly next to the site's
// sans chrome. When the shell-embedded render (the /d/:slug viewer) serves a
// doc with no font declaration of its own, we inject the site-wide system sans
// stack as the default instead. Docs that set any font rule are untouched, and
// because the injected rules use :where() (zero specificity) any author CSS
// would win anyway. Direct /raw fetches stay byte-pristine — like the comment
// overlay, this only rides the shell variant.

// An author font rule counts only in real CSS contexts: inside a <style> block
// or a style="" attribute. Prose or code samples that merely mention
// "font-family" must not count — a doc about CSS is not a styled doc.
function hasAuthoredFont(html: string): boolean {
  const blocks = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) ?? [];
  const rule = /font-family|font\s*:|@font-face/i;
  if (blocks.some((block) => rule.test(block))) return true;
  return /style\s*=\s*["'][^"']*font(-family)?\s*:/i.test(html);
}

/** The <style> injected into fontless docs by the shell render ("" if none). */
export function fontFallbackStyle(html: string): string {
  if (hasAuthoredFont(html)) return "";
  return `<style data-jh-default-font="1">:where(html){font-family:${SANS}}:where(code,kbd,samp,pre){font-family:${MONO}}</style>`;
}
