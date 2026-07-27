import { MARKDOWN_INPUT_SOURCE } from "@/lib/docs/markdown-input";

// Overlay script injected into the SANDBOXED iframe (/d/:slug/raw?overlay=1),
// and ONLY when the shell embeds it (the shell appends overlay=1; direct /raw
// fetches stay byte-pristine — birthday.md "Production architecture").
//
// The user HTML stays origin-less in the sandbox. This script runs INSIDE that
// sandbox and talks to the shell (the React rail) only via postMessage:
//
//   shell → overlay:  { type:"jh:anchors", anchors:[{id, exact, prefix, suffix}] }
//                     { type:"jh:reactions", me, avatars, groups:[{sig, exact, prefix, suffix,
//                          reactions:[{emoji,count,mine,authors}]}] }
//                     { type:"jh:active", id }            (hover sync; comment id or "rx:<sig>")
//                     { type:"jh:focus", key }            (focus a key from the rail; null clears)
//                     { type:"jh:scrollTo", id }
//                     { type:"jh:clearSelection" }
//                     { type:"jh:themeMode", mode }        ("dark"|"light" force doc theme; else auto)
//                     { type:"jh:editMode", on, allowed }  (enter/leave inline edit mode; allowed = viewer may edit)
//                     { type:"jh:editResult", ok }         (server verdict on the last jh:edit)
//                     { type:"jh:focusBlock", src, offset, scrollY }  (after an ops write + reload)
//                     { type:"jh:applyLink", href }        (URL collected for the pending Cmd-K)
//   overlay → shell:  { type:"jh:ready", r }         (r = the ?r= of the load that is answering)
//                     { type:"jh:positions", positions:{ [id]: yTopPx }, docHeight, scrollY }
//                          (comment highlight y in doc space; doc scroll for rail sync)
//                     { type:"jh:selection", anchor:{exact,prefix,suffix}, rect:{...} }
//                     { type:"jh:selectionCleared" }
//                     { type:"jh:focus", key, keys }      (a segment was clicked: focused key + full covering set)
//                     { type:"jh:hlHover", id } / { type:"jh:hlHoverOut" }
//                     { type:"jh:reactionToggle", anchor:{exact,prefix,suffix}, emoji } (chip click)
//                     { type:"jh:edit", changes:[{before, after, src, child}] }  (a block's text changed)
//                     { type:"jh:ops", ops, focus, scrollY }  (formatting/structure; shell posts to /ops)
//                     { type:"jh:editRejected", reason }   (edit not expressible; not sent)
//                     { type:"jh:editSel", active, marks, href, tag, rect }  (format toolbar state)
//                     { type:"jh:dirty", on }              (open block has unsaved changes)
//                     { type:"jh:words", words, chars }
//                     { type:"jh:linkPrompt", href }       (Cmd-K: shell should ask for a URL)
//                     { type:"jh:requestEditMode" }        (long-press on touch)
//
// B14 (birthday.md "Overlap semantics", founder-approved 2026-06-12): the one
// structural decision is **paint segments, not nested wrappers**. Partially-
// intersecting ranges can't nest in the DOM, so the overlay splits text nodes at
// EVERY anchor boundary (comments AND anchored reactions together) and each
// segment knows its covering set (the anchor keys spanning it).
//
//   - ONE PAINT CHANNEL: comments and reactions both paint background highlight
//     (founder: identical paint). Kind is distinguished by the attachment (rail
//     card vs. inline chip), never by paint.
//   - DEPTH SHADING: a segment's intensity scales with covering-set cardinality,
//     capped at 3 levels (1 = base yellow, 2 = darker, 3+ = darkest). This renders
//     exact-equal / subset / partial-intersection with no special-casing.
//   - FOCUS: click focuses the SMALLEST covering anchor; clicking the same spot
//     again cycles outward; focused anchor intensifies, others dim; 3+ covering
//     anchors → a tiny popover to pick directly. Esc / click-elsewhere clears.
//     Hovering a rail card / chip lights exactly its own span (rail is canonical).
//   - Reaction chips render at the END of THEIR OWN span (subset chip at the inner
//     end, outer chip at the outer end).
//
// The overlay resolves W3C text-quotes against the live DOM (prefix/suffix
// disambiguation). It never reads cookies (sandbox = opaque origin) and only
// accepts messages from the parent window.

export const OVERLAY_SCRIPT = String.raw`
(function(){
  "use strict";
  if (window.__jhOverlay) return; window.__jhOverlay = true;

  // Markdown-as-input parsers, injected from lib/docs/markdown-input.ts so the
  // rules the viewer types against are the ones the tests cover.
${MARKDOWN_INPUT_SOURCE}

  // Unified anchor model. Each entry: { key, kind:"comment"|"reaction", id (comment)
  // or sig (reaction), exact, prefix, suffix, reactions? }. key is "c:<id>" or "r:<sig>".
  // The reaction sig is the SERVER-SENT prefix|exact|suffix signature (canonical
  // definition: lib/docs/anchor.ts anchorSignature) — we CONSUME it, never recompute
  // it here; this stringified browser JS cannot import server code.
  var anchors = [];          // comment anchors from jh:anchors
  var rxGroups = [];         // reaction groups from jh:reactions
  var me = null;             // viewer email (for "(you)" in popovers)
  var items = [];            // resolved unified items (see resolveAll)
  var segs = [];             // painted segment <span data-jh-seg> elements
  var byKey = {};            // key -> { item, segEls:[], chipEls:[] }
  var activeKey = null;      // hover-highlighted key (transient)
  var focusKey = null;       // focused (pinned) key
  var pendingFocusScroll = null; // jh:focus scroll owed for a key not painted yet; applied on next paint()
  var lastClickKeys = null;  // covering set of the last focus click (for cycle)
  var lastClickPos = -1;     // doc-text offset of the last focus click (cycle reset on move)
  var sections = [];         // ordered [{id, level, text}] from jh:sections
  var secById = {};          // section id -> heading element (for scrollToSection)
  var pendingSection = null; // a scrollToSection requested before sections were applied

  function send(msg){ try { parent.postMessage(msg, "*"); } catch(e){} }
  function esc(s){ return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  // ---- adaptive chrome: sample the doc's AUTHORED colors (jh:theme) ----
  // Only the overlay (inside the sandboxed, opaque-origin iframe) can read the
  // doc's COMPUTED colors; the shell can't reach across the origin. We sample
  // bg/fg/accent via getComputedStyle and post {bg, fg, accent, isDark} so the
  // shell can derive variant-D dark chrome (lib/docs/theme.ts buildChromePalette).
  // We always report the AUTHORED colors (never a forced override): the shell gates
  // the chrome by the viewer's mode, so auto follows the doc and forced modes use a
  // fixed base — no stale forced tint lingers after switching back to auto. Captured
  // at init; emitted via jh:themeMode and re-emitted on load / a short settle for late
  // CSS. isDark uses WCAG luminance with a hysteresis dead-band to avoid flip-flop.
  var lastDark = null; // hysteresis memory across re-emits
  var forcedScheme = null; // viewer toggle: null = auto (doc as authored); "dark"|"light" force it
  var authoredTheme = null; // the doc's OWN colors (sampled only while unforced); reported
                            // in jh:theme even while forced, so auto chrome stays correct
  function rxParse(s){
    if (!s) return null;
    var m = String(s).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s\/]+([\d.%]+))?/i);
    if (!m) return null;
    if (m[4] != null){ var a = (""+m[4]).indexOf("%")>=0 ? parseFloat(m[4])/100 : parseFloat(m[4]); if (a === 0) return null; }
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  }
  function rxLum(rgb){
    var c = rgb.map(function(v){ v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); });
    return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];
  }
  // Read the document's OWN colors. Only meaningful while the doc is unforced — once a
  // theme is forced, the computed colors are our overrides, not the author's.
  function sampleAuthored(){
    var de = document.documentElement, body = document.body;
    var deCS = de ? getComputedStyle(de) : null;
    var bodyCS = body ? getComputedStyle(body) : null;
    // bg: documentElement bg; if transparent, fall back to body; both transparent → white.
    var bgRgb = deCS && rxParse(deCS.backgroundColor);
    var gradient = false;
    if (!bgRgb && bodyCS) bgRgb = rxParse(bodyCS.backgroundColor);
    // gradient/image: backgroundColor transparent but a backgroundImage exists.
    var bgImg = (deCS && deCS.backgroundImage) || (bodyCS && bodyCS.backgroundImage) || "none";
    if (!bgRgb && bgImg && bgImg !== "none") gradient = true;
    if (!bgRgb) bgRgb = [255,255,255]; // both transparent → treat as white (light)
    // fg: body color (fall back to documentElement).
    var fgRgb = (bodyCS && rxParse(bodyCS.color)) || (deCS && rxParse(deCS.color)) || [17,17,17];
    // accent: first <a>, else first heading.
    var accStr = null;
    var aEl = document.querySelector("a[href], a");
    if (!aEl) aEl = document.querySelector("h1, h2, h3");
    if (aEl){ var ac = rxParse(getComputedStyle(aEl).color); if (ac) accStr = "rgb("+ac[0]+","+ac[1]+","+ac[2]+")"; }
    var lum = rxLum(bgRgb);
    // hysteresis dead-band around 0.4: once dark, stay dark until >0.46; once light,
    // stay light until <0.34. First sample uses the bare 0.4 threshold.
    var dark;
    if (lastDark === true) dark = lum < 0.46;
    else if (lastDark === false) dark = lum < 0.34;
    else dark = lum < 0.4;
    lastDark = dark;
    return {
      bg: "rgb("+Math.round(bgRgb[0])+","+Math.round(bgRgb[1])+","+Math.round(bgRgb[2])+")",
      fg: "rgb("+Math.round(fgRgb[0])+","+Math.round(fgRgb[1])+","+Math.round(fgRgb[2])+")",
      accent: accStr || undefined,
      isDark: dark,
      gradient: gradient
    };
  }
  // Effective darkness of what the viewer actually SEES: a forced theme wins, otherwise
  // the authored darkness. Drives the in-doc highlight treatment (jh-dark).
  function effectiveDark(){
    if (forcedScheme === "dark") return true;
    if (forcedScheme === "light") return false;
    return authoredTheme ? !!authoredTheme.isDark : false;
  }
  function sampleTheme(){
    try {
      // Only re-read the doc while it's showing its authored colors; while forced we keep
      // the last authored sample (captured at init / when last unforced).
      if (!forcedScheme) authoredTheme = sampleAuthored();
      // Highlight styling follows the EFFECTIVE darkness (forced or authored) so it
      // contrasts with what's actually painted on the page.
      try { ensureStyle(); if (document.documentElement) document.documentElement.classList.toggle("jh-dark", effectiveDark()); } catch(e){}
      // Report the AUTHORED theme. The shell gates the chrome by the viewer's mode
      // (auto → this sample; dark/light → forced chrome), so it's correct in every mode
      // and never left tinted by a stale forced sample after switching back to auto.
      if (authoredTheme) send({ type:"jh:theme", bg: authoredTheme.bg, fg: authoredTheme.fg, accent: authoredTheme.accent, isDark: authoredTheme.isDark, gradient: authoredTheme.gradient });
    } catch(e){}
  }

  // ---- forced document theme (viewer's light/dark toggle) ----
  // The toggle themes the chrome (bar/rail) in the shell; this repaints the DOCUMENT.
  // Setting body color alone doesn't work — authored rules like p,li{color:#1a1a1a}
  // beat inheritance. And blanket-whitening every element breaks anything with its own
  // (light) background: code blocks, badges, callout boxes would get white-on-light.
  // So: force color-scheme + the page background, then WALK the DOM and recolor only
  // the text of elements sitting ON that page background. Any element with its own
  // background (or a code block) keeps its authored colors, and so does its subtree —
  // "leave code alone", generalized. Links keep their accent. "auto" removes it all.
  // (@media(prefers-color-scheme) still can't be driven from script.)
  var FG_SKIP = { SCRIPT:1, STYLE:1, PRE:1, CODE:1, SVG:1, IMG:1, CANVAS:1, VIDEO:1, IFRAME:1, A:1, BUTTON:1, INPUT:1, SELECT:1, TEXTAREA:1, OPTION:1, NOSCRIPT:1 };
  function ownsBackground(el){
    try {
      var bg = getComputedStyle(el).backgroundColor;
      if (!bg || bg === "transparent") return false;
      var m = bg.match(/rgba?\(([^)]+)\)/);
      if (m){ var p = m[1].split(","); return p.length < 4 || parseFloat(p[3]) > 0.05; }
      return true;
    } catch(e){ return false; }
  }
  // A "surface" starts its own background and keeps its authored text. Highlight
  // segments are NOT surfaces even though they carry a wash background in light mode —
  // their text is document prose and must recolor with the page (else it goes
  // dark-on-dark once the wash turns to an underline under jh-dark).
  function isSurface(el, tag){ return !el.hasAttribute("data-jh-seg") && (tag === "PRE" || tag === "CODE" || ownsBackground(el)); }
  // PASS 1 — before any whitening, pin each surface's authored text color inline. A
  // surface (code block / anything with its own background) often has no color of its
  // own and relies on inheriting the body's dark text; once we whiten its ancestor
  // that inheritance would turn its text white on a light surface. A direct inline
  // color beats inheritance, so this preserves the authored look ("keep font color").
  function pinSurfaces(el){
    var kids = el.children;
    for (var i = 0; i < kids.length; i++){
      var c = kids[i], tag = c.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") continue;
      if (isSurface(c, tag)){
        if (!c.hasAttribute("data-jh-fg-pin")){
          c.setAttribute("data-jh-fg-pin", c.style.color);
          c.style.color = getComputedStyle(c).color;
        }
      } else {
        pinSurfaces(c);
      }
    }
  }
  // PASS 2 — recolor text of elements sitting ON the page background; skip surfaces
  // (and their subtrees), links, and media. Highlight segments (data-jh-seg) ARE
  // recolored here — they're prose and must follow the page — with an !important that
  // beats any authored span color rule; segments inside code sit inside a surface and
  // are never reached, so highlighted code text keeps its own color.
  function whitenPage(el){
    var kids = el.children;
    for (var i = 0; i < kids.length; i++){
      var c = kids[i], tag = c.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") continue;
      if (isSurface(c, tag)) continue;
      if (!FG_SKIP[tag]) c.classList.add("jh-doc-fg");
      whitenPage(c);
    }
  }
  function markForcedText(){
    try {
      var pinned = document.querySelectorAll("[data-jh-fg-pin]");
      for (var i = 0; i < pinned.length; i++){ var e = pinned[i]; e.style.color = e.getAttribute("data-jh-fg-pin") || ""; e.removeAttribute("data-jh-fg-pin"); }
      var whited = document.querySelectorAll(".jh-doc-fg");
      for (var j = 0; j < whited.length; j++) whited[j].classList.remove("jh-doc-fg");
      if (!forcedScheme || !document.body) return;
      pinSurfaces(document.body);
      whitenPage(document.body);
    } catch(e){}
  }
  function applyDocScheme(){
    try {
      var de = document.documentElement; if (!de) return;
      var st = document.getElementById("jh-doc-theme");
      if (!forcedScheme){
        de.classList.remove("jh-force-dark", "jh-force-light");
        de.style.colorScheme = "";
        if (st && st.parentNode) st.parentNode.removeChild(st);
        markForcedText();
        return;
      }
      if (!st){
        st = document.createElement("style"); st.id = "jh-doc-theme";
        st.textContent =
          "html.jh-force-dark{color-scheme:dark}"
          + "html.jh-force-dark,html.jh-force-dark body{background-color:#0d1117!important}"
          + "html.jh-force-dark .jh-doc-fg{color:#fff!important}"
          + "html.jh-force-light{color-scheme:light}"
          + "html.jh-force-light,html.jh-force-light body{background-color:#ffffff!important}"
          + "html.jh-force-light .jh-doc-fg{color:#111!important}";
        (document.head || de).appendChild(st);
      }
      de.classList.toggle("jh-force-dark", forcedScheme === "dark");
      de.classList.toggle("jh-force-light", forcedScheme === "light");
      de.style.colorScheme = forcedScheme;
      markForcedText();
    } catch(e){}
  }

  // ---- text-content walker (anchor resolution against the live DOM) ----
  // We snapshot the text model ONCE per paint (over the pristine DOM, before any
  // segment wrapping), resolve every anchor's [start,end) against it, then split.
  function buildText(){
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var nodes = [], full = "";
    while (walker.nextNode()){
      var n = walker.currentNode;
      var p = n.parentNode;
      if (p && (p.nodeName === "SCRIPT" || p.nodeName === "STYLE")) continue;
      // skip text inside our own chips / section-anchors so injected UI never
      // becomes anchorable text
      if (p && p.closest && p.closest("[data-jh-chip],[data-jh-sec-anchor]")) continue;
      nodes.push({ node: n, start: full.length });
      full += n.nodeValue;
    }
    return { nodes: nodes, full: full };
  }
  function locate(nodes, offset){
    for (var i=0;i<nodes.length;i++){
      var e = nodes[i];
      if (offset >= e.start && offset <= e.start + e.node.nodeValue.length)
        return { node: e.node, offset: offset - e.start };
    }
    return null;
  }
  // Like locate but forward-biased for a range START: an offset sitting exactly on
  // a text-node boundary resolves to the NEXT node's start, not the previous node's
  // end. Otherwise a range whose first character is the start of a block (a heading,
  // a paragraph) begins at the block's leading edge, and wrapping it pulls the whole
  // block into an inline <span> — whose background never paints, so the highlight
  // silently vanishes. Bias the start inward so we wrap the text, not the block.
  function locateStart(nodes, offset){
    for (var i=0;i<nodes.length;i++){
      var e = nodes[i], len = e.node.nodeValue.length;
      if (offset >= e.start && offset < e.start + len) return { node: e.node, offset: offset - e.start };
      if (offset === e.start + len){
        var nx = nodes[i+1];
        if (nx && nx.start === offset) return { node: nx.node, offset: 0 };
        return { node: e.node, offset: len };
      }
    }
    return null;
  }
  function squash(s){ return (s||"").replace(/\s+/g," "); }

  // Resolve an anchor against the snapshot text → {start, len} (offsets into full),
  // or null. Mirrors the prior findRange logic but returns offsets (not a live
  // Range), so segment splitting can compose all anchors against a single model.
  function resolveOffsets(full, a){
    var occ = [], from = 0, idx;
    while ((idx = full.indexOf(a.exact, from)) !== -1){ occ.push(idx); from = idx + 1; if (occ.length>5000) break; }
    if (occ.length === 0){
      var nf = squash(full), ne = squash(a.exact), ni = nf.indexOf(ne);
      if (ni < 0) return null;
      var raw = 0, nrm = 0;
      while (nrm < ni && raw < full.length){ if (/\s/.test(full[raw])){ while(/\s/.test(full[raw])) raw++; nrm++; } else { raw++; nrm++; } }
      var end = raw, c = 0, neLen = ne.length;
      while (c < neLen && end < full.length){ if (/\s/.test(full[end])){ while(/\s/.test(full[end])) end++; c++; } else { end++; c++; } }
      return { start: raw, len: end - raw };
    }
    var pick = occ[0];
    if (occ.length > 1){
      var wantP = squash(a.prefix||""), wantS = squash(a.suffix||"");
      var best = -1, bestIdx = -1, tie = false;
      for (var k=0;k<occ.length;k++){
        var i2 = occ[k];
        var before = squash(full.slice(Math.max(0,i2-80), i2));
        var after = squash(full.slice(i2+a.exact.length, i2+a.exact.length+80));
        var score = 0;
        if (wantP){ var n=Math.min(before.length,wantP.length),x=0; while(x<n&&before[before.length-1-x]===wantP[wantP.length-1-x])x++; score+=x; }
        if (wantS){ var m=Math.min(after.length,wantS.length),y=0; while(y<m&&after[y]===wantS[y])y++; score+=y; }
        if (score>best){ best=score; bestIdx=i2; tie=false; } else if (score===best){ tie=true; }
      }
      if (tie && best<=0) return null;
      pick = bestIdx;
    }
    return { start: pick, len: a.exact.length };
  }

  function mkRange(nodes, start, len){
    var a = locateStart(nodes, start), b = locate(nodes, start+len);
    if (!a || !b) return null;
    try { var r = document.createRange(); r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); return r; } catch(e){ return null; }
  }

  function clearHighlights(){
    // unwrap segment spans, restoring the pristine text flow
    document.querySelectorAll("span[data-jh-seg]").forEach(function(m){
      var p=m.parentNode; if(!p) return; while(m.firstChild) p.insertBefore(m.firstChild,m); p.removeChild(m);
    });
    document.querySelectorAll("[data-jh-chip]").forEach(function(n){ n.remove(); });
    if (document.body) document.body.normalize();
    segs = [];
    byKey = {};
  }

  function ensureStyle(){
    if (document.getElementById("jh-overlay-style")) return;
    var st = document.createElement("style"); st.id = "jh-overlay-style";
    // DEPTH SHADING (founder: capped at 3 levels). Comments AND reactions paint the
    // SAME channel — background highlight — so a segment's class is driven purely by
    // its covering-set CARDINALITY, never by kind. d1 base yellow, d2 darker, d3
    // darkest (3+). .jh-focus intensifies the focused anchor's segments; .jh-dim
    // fades non-focused overlapping highlights when a focus is active.
    st.textContent =
      "span[data-jh-seg]{cursor:pointer;transition:background .12s,opacity .12s,box-shadow .12s}"
      + "span[data-jh-seg].d1{background:#fff3bf;border-bottom:1px solid #f1d96b}"
      + "span[data-jh-seg].d2{background:#ffe08a;border-bottom:1px solid #e8c44e}"
      + "span[data-jh-seg].d3{background:#ffc94d;border-bottom:1px solid #e0a92e}"
      + "span[data-jh-seg].jh-hover{background:#ffd76b}"
      + "span[data-jh-seg].jh-focus{background:#ffce3a;box-shadow:inset 0 0 0 9999px rgba(255,179,0,.18)}"
      + "span[data-jh-seg].jh-dim{opacity:.4}"
      // DARK DOC (adaptive chrome, variant D): a filled wash reads as muddy on a
      // dark page, so instead of a background we mark the span with a warm amber
      // UNDERLINE (depth = opacity) and leave the doc's own text untouched. Hover
      // and focus add a faint transient wash for feedback only. Gated by a .jh-dark
      // class on <html> set from sampleTheme.
      + "html.jh-dark span[data-jh-seg].d1{background:transparent;border-bottom:2px solid rgba(245,197,24,.8)}"
      + "html.jh-dark span[data-jh-seg].d2{background:transparent;border-bottom:2px solid rgba(245,197,24,.92)}"
      + "html.jh-dark span[data-jh-seg].d3{background:transparent;border-bottom:2px solid #f5c518}"
      + "html.jh-dark span[data-jh-seg].jh-hover{background:rgba(245,197,24,.14)}"
      + "html.jh-dark span[data-jh-seg].jh-focus{background:rgba(245,197,24,.2);box-shadow:0 0 0 1px rgba(245,197,24,.85)}"
      + "span[data-jh-chip]{display:inline-flex;align-items:center;gap:2px;font-size:11.5px;line-height:1;"
      + "background:#fbfbfb;border:1px solid #e0e0e0;border-radius:10px;padding:1px 6px 1px 5px;margin-left:4px;"
      + "vertical-align:.12em;font-family:ui-monospace,Menlo,Consolas,monospace;cursor:pointer;user-select:none;"
      + "white-space:nowrap;transition:border-color .1s,background .1s,opacity .12s}"
      + "span[data-jh-chip]:hover{border-color:#bbb;background:#fff}"
      + "span[data-jh-chip].mine{border-color:#9db8d8;background:#eef3fb}"
      + "span[data-jh-chip].jh-dim{opacity:.4}"
      + "span[data-jh-chip] .jh-em{font-size:13px}"
      + "span[data-jh-chip] .jh-ct{color:#666}"
      + "span[data-jh-chip].mine .jh-ct{color:#3a5b8a}"
      // dark chips: lift the surface off the dark doc, keep text readable.
      + "html.jh-dark span[data-jh-chip]{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.18);color:inherit}"
      + "html.jh-dark span[data-jh-chip]:hover{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.3)}"
      + "html.jh-dark span[data-jh-chip].mine{background:rgba(120,170,255,.2);border-color:rgba(120,170,255,.5)}"
      + "html.jh-dark span[data-jh-chip] .jh-ct{color:rgba(255,255,255,.6)}"
      + "html.jh-dark span[data-jh-chip].mine .jh-ct{color:#9db8d8}"
      + ".jh-pop{position:fixed;display:none;background:#fff;border:1px solid #ccc;border-radius:6px;"
      + "box-shadow:0 4px 16px rgba(0,0,0,.18);z-index:2147483647;padding:6px 8px;font-size:11px;max-width:280px;"
      + "font-family:ui-monospace,Menlo,Consolas,monospace;color:#222}"
      + ".jh-pop .jh-row{display:flex;align-items:center;gap:6px;padding:3px 4px;border-radius:4px}"
      + ".jh-pick .jh-row{cursor:pointer}"
      + ".jh-pick .jh-row:hover{background:#f3f3f3}"
      + ".jh-pop img{width:18px;height:18px;border-radius:50%}"
      + ".jh-pop .jh-hdr{color:#888;font-size:10px;margin-bottom:3px}"
      + ".jh-pop .jh-kind{color:#999;font-size:10px;margin-left:4px}";
    (document.head||document.documentElement).appendChild(st);
  }

  // ---- section deeplinks (heading gutter link icon + scroll-to) ----
  // The shell sends the server's ordered section list; we assign each id to the
  // heading at the same document-order index (server + DOM agree on order), set
  // scroll-margin so a scrolled-to heading isn't flush to the top, and inject a
  // hover-reveal link icon in the left gutter. Clicking it asks the shell to copy
  // the permalink — clipboard is unreliable from this opaque-origin sandbox, so
  // the shell (real origin) does the write. Idempotent: re-running updates in place.
  var LINK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

  function ensureSectionStyle(){
    if (document.getElementById("jh-sec-style")) return;
    var st = document.createElement("style"); st.id = "jh-sec-style";
    st.textContent =
      "h1,h2,h3,h4,h5,h6{scroll-margin-top:1.5rem}"
      // Inline (not absolute) so it rides the heading's first text line and stays
      // vertically centered regardless of the doc's own top padding/border/margin;
      // the negative-left + right margins net to zero width so text doesn't shift.
      + "a.jh-sec-anchor{display:inline-flex;align-items:center;justify-content:center;"
      + "width:1em;height:1em;margin:0 .35em 0 -1.35em;vertical-align:middle;opacity:0;"
      + "text-decoration:none;color:currentColor;transition:opacity .12s}"
      + "h1:hover>a.jh-sec-anchor,h2:hover>a.jh-sec-anchor,h3:hover>a.jh-sec-anchor,"
      + "h4:hover>a.jh-sec-anchor,h5:hover>a.jh-sec-anchor,h6:hover>a.jh-sec-anchor{opacity:.5}"
      + "a.jh-sec-anchor:hover,a.jh-sec-anchor:focus{opacity:.9;outline:none}"
      + "@keyframes jh-sec-flash{0%,100%{background-color:transparent}18%{background-color:rgba(245,197,24,.35)}}"
      + ".jh-sec-target{animation:jh-sec-flash 1.6s ease;border-radius:3px}";
    (document.head||document.documentElement).appendChild(st);
  }

  function addSectionAnchor(h, id){
    var ex = h.querySelector(":scope > a.jh-sec-anchor");
    if (ex){ ex.setAttribute("data-jh-sec", id); ex.setAttribute("href", "#"+id); return; }
    var a = document.createElement("a");
    a.className = "jh-sec-anchor";
    a.setAttribute("data-jh-sec-anchor", "1");
    a.setAttribute("data-jh-sec", id);
    a.setAttribute("href", "#"+id);
    a.setAttribute("aria-label", "Copy link to section");
    a.innerHTML = LINK_SVG;
    a.addEventListener("click", function(ev){
      ev.preventDefault(); ev.stopPropagation();
      send({type:"jh:copyLink", id: a.getAttribute("data-jh-sec")});
    });
    h.insertBefore(a, h.firstChild);
  }

  function applySections(){
    try {
      ensureSectionStyle();
      var heads = document.querySelectorAll("h1,h2,h3,h4,h5,h6");
      secById = {};
      var n = Math.min(sections.length, heads.length);
      for (var i=0;i<n;i++){
        var s = sections[i]; if (!s || !s.id) continue;
        var h = heads[i];
        h.id = s.id;
        secById[s.id] = h;
        addSectionAnchor(h, s.id);
      }
      // Consume a scroll requested before sections existed: resolve it against this
      // freshly-applied set and clear it either way, so it can't be retried on a
      // LATER applySections (reload / jh:sections update) and scroll to an abandoned
      // section after the user has since navigated elsewhere.
      if (pendingSection != null){
        var ps = pendingSection; pendingSection = null;
        if (secById[ps]) scrollToSection(ps);
      }
    } catch(e){}
  }

  function scrollToSection(id){
    var h = secById[id];
    if (!h){ pendingSection = id; return; } // sections not applied yet — honor after applySections
    pendingSection = null;
    try { h.scrollIntoView({block:"start", behavior:"smooth"}); } catch(e){ try { h.scrollIntoView(); } catch(e2){} }
    try { h.classList.add("jh-sec-target"); setTimeout(function(){ h.classList.remove("jh-sec-target"); }, 1600); } catch(e){}
  }

  // ---- segment painting (the B14 core) ----
  function paint(){
    // Never repaint mid-edit: wrapping segments splits the text nodes we're
    // diffing and would drop the caret. setEditMode(false) repaints on exit, and
    // the anchors/rxGroups vars keep accumulating meanwhile, so nothing is lost.
    if (editing) return;
    ensureStyle();
    clearHighlights();
    var tx = buildText();
    var full = tx.full;

    // 1) resolve EVERY anchor (comments + reactions) to offsets against one model.
    items = [];
    anchors.forEach(function(a){
      if (!a.exact) return;
      var o = resolveOffsets(full, a);
      if (!o || o.len <= 0) return;
      items.push({ key: "c:"+a.id, kind:"comment", id:a.id, exact:a.exact, prefix:a.prefix, suffix:a.suffix,
                   start:o.start, end:o.start+o.len });
    });
    rxGroups.forEach(function(g){
      if (!g.exact) return;
      var o = resolveOffsets(full, g);
      if (!o || o.len <= 0) return;
      items.push({ key: "r:"+g.sig, kind:"reaction", sig:g.sig, exact:g.exact, prefix:g.prefix, suffix:g.suffix,
                   reactions:g.reactions||[], start:o.start, end:o.start+o.len });
    });
    items.forEach(function(it){ byKey[it.key] = { item: it, segEls: [], chipEls: [] }; });

    // 2) boundary split: collect every range edge; for each [b,b+1) segment compute
    //    its covering set (items whose [start,end) contains it). Only paint covered
    //    segments. This is what makes partially-intersecting ranges renderable —
    //    they can't nest in the DOM, but disjoint segments can.
    var bset = {};
    items.forEach(function(it){ bset[it.start]=1; bset[it.end]=1; });
    var bounds = Object.keys(bset).map(Number).sort(function(a,b){return a-b;});
    var segments = []; // {start,end,cover:[keys]}
    for (var i=0;i<bounds.length-1;i++){
      var s = bounds[i], e = bounds[i+1];
      if (e <= s) continue;
      var cover = [];
      for (var j=0;j<items.length;j++){ var it=items[j]; if (it.start<=s && it.end>=e) cover.push(it.key); }
      if (cover.length) segments.push({ start:s, end:e, cover:cover });
    }

    // 3) wrap each segment. Process LAST-to-FIRST so wrapping an earlier segment
    //    never invalidates the offsets of a later one (we re-walk per wrap, but
    //    reverse order keeps untouched offsets stable in the model we re-query).
    for (var k=segments.length-1;k>=0;k--){
      var seg = segments[k];
      var r = mkRange(tx.nodes, seg.start, seg.end - seg.start);
      if (!r) continue;
      try {
        var span = document.createElement("span");
        span.setAttribute("data-jh-seg","1");
        span.setAttribute("data-cover", seg.cover.join(","));
        var depth = Math.min(3, seg.cover.length);
        span.className = "d"+depth;
        span.appendChild(r.extractContents());
        r.insertNode(span);
        seg.cover.forEach(function(key){ if (byKey[key]) byKey[key].segEls.push(span); });
        segs.push(span);
        attachSegHandlers(span, seg);
      } catch(e){}
      document.body.normalize();
      tx = buildText(); // re-snapshot for the next (earlier) segment
    }

    // 4) reaction chips at the END of each reaction's OWN span. We find the
    //    rightmost painted segment belonging to the reaction (its inner/outer end)
    //    and append the chip set just after it, inline in the text flow.
    items.forEach(function(it){
      if (it.kind !== "reaction") return;
      var rec = byKey[it.key]; if (!rec || !rec.segEls.length) return;
      // segEls were pushed in reverse document order (we wrapped last→first); the
      // span ending at it.end is the one whose following text starts at it.end.
      var endSpan = rec.segEls[0]; // first pushed = last wrapped = earliest; recompute by DOM
      // pick the span that is last in document order among this item's segments
      endSpan = rec.segEls.reduce(function(acc, el){
        if (!acc) return el;
        return (acc.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) ? el : acc;
      }, null);
      if (!endSpan) return;
      var frag = document.createDocumentFragment();
      (it.reactions||[]).forEach(function(rx){
        var chip = document.createElement("span");
        chip.setAttribute("data-jh-chip","1");
        chip.setAttribute("data-rxkey", it.key);
        if (rx.mine) chip.className = "mine";
        chip.innerHTML = '<span class="jh-em">'+esc(rx.emoji)+'</span><span class="jh-ct">'+rx.count+'</span>';
        chip.title = (rx.authors||[]).join(", ");
        (function(it, rx){
          chip.addEventListener("click", function(ev){
            ev.stopPropagation();
            send({type:"jh:reactionToggle", anchor:{exact:it.exact, prefix:it.prefix, suffix:it.suffix}, emoji:rx.emoji});
          });
          chip.addEventListener("mouseenter", function(ev){
            // rail → doc: hovering a chip lights exactly ITS span (unambiguous).
            setHover(it.key);
            showRxPop(ev.currentTarget, rx.emoji, rx.authors||[]);
          });
          chip.addEventListener("mouseleave", function(){ setHover(null); hidePop(); });
        })(it, rx);
        frag.appendChild(chip);
        rec.chipEls.push(chip);
      });
      endSpan.after(frag);
    });

    applyFocusStyles();
    reportPositions();
    // Re-apply the forced-theme text coloring: paint just (re)created the highlight
    // segments, and a re-paint (reload after a comment, resize) carries no themeMode
    // message, so newly wrapped segments would otherwise miss the recolor.
    if (forcedScheme) markForcedText();
  }

  // A focus scroll owed for a key that wasn't painted at focus time (a resolved
  // thread revealed on a permalink): resolve it against a fresh anchor set. Scroll
  // if the segment now exists, and clear the request either way — after jh:anchors
  // an absent key is orphaned, so it must not linger and fire on a later repaint.
  function consumePendingFocus(){
    if (pendingFocusScroll == null) return;
    var rec = byKey[pendingFocusScroll];
    if (rec && rec.segEls.length) scrollToKey(pendingFocusScroll);
    pendingFocusScroll = null;
  }

  // ---- segment interaction (doc → rail focus model) ----
  function attachSegHandlers(span, seg){
    span.addEventListener("mouseenter", function(){
      // hover lights every segment sharing the SMALLEST covering anchor under the
      // cursor (so hovering the doc behaves like hovering that anchor's whole span)
      var sm = smallestKey(seg.cover);
      setHover(sm);
      send({type:"jh:hlHover", id: keyToId(sm)});
    });
    span.addEventListener("mouseleave", function(){ setHover(null); send({type:"jh:hlHoverOut"}); });
    span.addEventListener("click", function(ev){
      ev.stopPropagation();
      onSegClick(seg, ev);
    });
  }

  // covering set ordered SMALLEST span first (subset before superset). Ties broken
  // by key for stability.
  function orderBySize(keys){
    return keys.slice().sort(function(ka, kb){
      var a = byKey[ka] && byKey[ka].item, b = byKey[kb] && byKey[kb].item;
      if (!a || !b) return 0;
      var da = a.end - a.start, db = b.end - b.start;
      if (da !== db) return da - db;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  function smallestKey(keys){ var o = orderBySize(keys); return o.length ? o[0] : null; }

  function onSegClick(seg, ev){
    var ordered = orderBySize(seg.cover);
    if (ordered.length >= 3){
      // 3+ covering anchors → tiny popover to pick directly (no blind cycling).
      showPickPop(ev.clientX, ev.clientY, ordered);
      return;
    }
    // 1 or 2: focus smallest; clicking the same spot cycles outward through the set.
    var samePoint = (lastClickPos === seg.start) && lastClickKeys && sameArr(lastClickKeys, ordered);
    var idx = 0;
    if (samePoint && focusKey){
      var cur = ordered.indexOf(focusKey);
      idx = (cur + 1) % ordered.length;
    }
    lastClickPos = seg.start;
    lastClickKeys = ordered;
    setFocus(ordered[idx], ordered);
  }
  function sameArr(a, b){ if (a.length !== b.length) return false; for (var i=0;i<a.length;i++) if (a[i]!==b[i]) return false; return true; }

  function setHover(key){
    activeKey = key;
    applyFocusStyles();
  }
  // focus a key; broadcast to the shell so it can pin/scroll the rail card.
  function setFocus(key, coverKeys){
    focusKey = key;
    applyFocusStyles();
    send({type:"jh:focus", key:key, id: keyToId(key), keys: coverKeys || (key?[key]:[]) });
  }
  function keyToId(key){
    if (!key) return null;
    if (key.indexOf("c:") === 0) return Number(key.slice(2));
    return key; // reaction keys pass through as "r:<sig>" (rail uses sig)
  }

  function applyFocusStyles(){
    segs.forEach(function(el){
      var cover = (el.getAttribute("data-cover")||"").split(",").filter(Boolean);
      el.classList.remove("jh-hover","jh-focus","jh-dim");
      var depth = Math.min(3, cover.length);
      // Rebuild the base class but KEEP jh-doc-fg — otherwise a hover/focus recolor
      // strips the forced-theme text color and the segment reverts to dark-on-dark.
      el.className = "d"+depth + (el.classList.contains("jh-doc-fg") ? " jh-doc-fg" : "");
      if (focusKey){
        if (cover.indexOf(focusKey) !== -1) el.classList.add("jh-focus");
        else el.classList.add("jh-dim");
      }
      if (activeKey && cover.indexOf(activeKey) !== -1 && !focusKey) el.classList.add("jh-hover");
    });
    // dim chips not belonging to the focused key
    document.querySelectorAll("[data-jh-chip]").forEach(function(c){
      c.classList.remove("jh-dim");
      if (focusKey){ if (c.getAttribute("data-rxkey") !== focusKey) c.classList.add("jh-dim"); }
    });
  }

  function clearFocus(){
    focusKey = null; lastClickKeys = null; lastClickPos = -1;
    applyFocusStyles();
    send({type:"jh:focus", key:null, id:null, keys:[]});
  }

  // click-elsewhere (on non-highlight) clears focus + selection popovers
  document.addEventListener("click", function(ev){
    var t = ev.target;
    if (t && t.closest && (t.closest("[data-jh-seg]") || t.closest("[data-jh-chip]") || t.closest(".jh-pop"))) return;
    hidePop();
    if (focusKey) clearFocus();
  });
  document.addEventListener("keydown", function(ev){
    if (ev.key === "Escape"){ hidePop(); if (focusKey) clearFocus(); }
  });

  // ---- popovers (reactor list + 3+ picker) ----
  function popEl(){
    var p = document.getElementById("jh-pop");
    if (!p){ p = document.createElement("div"); p.id = "jh-pop"; p.className = "jh-pop"; (document.body||document.documentElement).appendChild(p); }
    return p;
  }
  function av(email){
    if (window.__jhAvatars && window.__jhAvatars[email]) return window.__jhAvatars[email];
    return null;
  }
  function showRxPop(chipEl, emoji, authors){
    var p = popEl(); p.className = "jh-pop";
    p.innerHTML = '<div class="jh-hdr">'+esc(emoji)+' reacted by</div>' +
      authors.map(function(a){
        var url = av(a); var img = url ? '<img src="'+esc(url)+'" alt="">' : '';
        var you = (me && a===me) ? ' <span style="color:#3a5b8a">(you)</span>' : '';
        return '<div class="jh-row">'+img+esc(a)+you+'</div>';
      }).join("");
    p.style.display = "block";
    var r = chipEl.getBoundingClientRect();
    p.style.left = Math.min(r.left, window.innerWidth - 290) + "px";
    p.style.top = (r.bottom + 6) + "px";
  }
  // 3+ covering anchors: list them (comment snippet / reaction emoji) to pick directly.
  function showPickPop(x, y, orderedKeys){
    var p = popEl(); p.className = "jh-pop jh-pick";
    p.innerHTML = '<div class="jh-hdr">'+orderedKeys.length+' overlapping — pick one</div>' +
      orderedKeys.map(function(key){
        var it = byKey[key] && byKey[key].item; if (!it) return "";
        if (it.kind === "comment"){
          var snip = esc(it.exact.slice(0,40)) + (it.exact.length>40?"…":"");
          return '<div class="jh-row" data-key="'+esc(key)+'">💬 <span>'+snip+'</span></div>';
        }
        var ems = (it.reactions||[]).map(function(rx){ return esc(rx.emoji); }).join(" ");
        var snip2 = esc(it.exact.slice(0,30)) + (it.exact.length>30?"…":"");
        return '<div class="jh-row" data-key="'+esc(key)+'">'+ems+' <span class="jh-kind">'+snip2+'</span></div>';
      }).join("");
    p.style.display = "block";
    p.style.left = Math.min(x, window.innerWidth - 300) + "px";
    p.style.top = (y + 8) + "px";
    p.querySelectorAll(".jh-row").forEach(function(row){
      row.addEventListener("click", function(ev){
        ev.stopPropagation();
        var key = row.getAttribute("data-key");
        hidePop();
        lastClickKeys = orderedKeys; lastClickPos = -1;
        setFocus(key, orderedKeys);
      });
    });
  }
  function hidePop(){ var p = document.getElementById("jh-pop"); if (p) p.style.display = "none"; }

  // ---- positions for rail-card alignment (comment highlights only) ----
  function reportPositions(){
    var pos = {};
    items.forEach(function(it){
      if (it.kind !== "comment") return;
      var rec = byKey[it.key]; if (!rec || !rec.segEls.length) return;
      // topmost segment of this comment = its anchor's start y
      var top = Infinity;
      rec.segEls.forEach(function(el){ var rt = el.getBoundingClientRect().top + window.scrollY; if (rt < top) top = rt; });
      if (top !== Infinity) pos[it.id] = top;
    });
    send({type:"jh:positions", positions: pos, docHeight: document.documentElement.scrollHeight, scrollY: window.scrollY});
  }

  function scrollToKey(key){
    var rec = byKey[key]; if (!rec || !rec.segEls.length) return;
    rec.segEls[0].scrollIntoView({block:"center", behavior:"smooth"});
  }

  // ---- inline edit mode (owners + editor grantees) ----
  //
  // TWO WRITE PATHS, chosen by what actually changed.
  //
  // TYPING is a text patch. A block's text nodes are snapshotted when it opens
  // and diffed when it commits; the shell posts {oldText,newText} to /edits.
  // Nothing reloads, the caret never moves, and comment anchors ride the patch's
  // offset map. This is the path this file already had.
  //
  // FORMATTING AND STRUCTURE is an op. Bold, links, block type, new blocks,
  // deletes, reordering, list nesting, tables: each names an element by the
  // data-jh-src id it was served with and says what it should become, and the
  // shell posts that to /ops (lib/docs/doc-ops.ts renders it). The overlay does
  // NOT apply these to the DOM itself. The iframe reloads against the bytes that
  // were actually written and the caret is put back, because the alternative is a
  // second markup renderer living here that has to agree with the server's
  // forever — and the moment it drifts, the document you see stops being the
  // document that is stored.
  //
  // MARKDOWN IS AN INPUT METHOD, never a storage format: mdInline/mdBlocks parse
  // what was typed into runs and blocks, the server renders those to html, and
  // nothing round-trips back to asterisks.
  var editing = false;      // edit mode on: blocks are click-to-edit
  var editAllowed = false;  // viewer may edit at all (drives long-press on touch)
  var editEl = null;        // the block currently contentEditable
  var editSnap = null;      // { nodes:[{node,text}], html } baseline for editEl
  var editSent = null;      // snapshot to revert from, awaiting the shell's jh:editResult
  var editDirty = false;    // editEl has changes the server has not accepted yet
  var TEXT_BLOCKS = "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dd,dt,td,th,caption,summary";
  var EDIT_BLOCKS = TEXT_BLOCKS + ",pre";
  var MARK_OF = { STRONG:"strong", B:"strong", EM:"em", I:"em", CODE:"code", DEL:"del", S:"del", STRIKE:"del" };
  var SLASH_ITEMS = [
    { key:"p", label:"Text" },
    { key:"h1", label:"Heading 1" },
    { key:"h2", label:"Heading 2" },
    { key:"h3", label:"Heading 3" },
    { key:"ul", label:"Bulleted list" },
    { key:"ol", label:"Numbered list" },
    { key:"blockquote", label:"Quote" },
    { key:"pre", label:"Code" },
    { key:"hr", label:"Divider" },
    { key:"table", label:"Table" }
  ];

  function srcOf(el){
    if (!el || !el.getAttribute) return null;
    var v = el.getAttribute("data-jh-src");
    return v == null ? null : Number(v);
  }
  function elBySrc(src){
    return src == null ? null : document.querySelector('[data-jh-src="' + src + '"]');
  }
  // Nodes this overlay injected. They exist in the DOM and not in the stored
  // bytes, so every index we compute against the source has to step over them.
  function isOurs(n){
    return !!(n && n.nodeType === 1 && n.hasAttribute &&
      (n.hasAttribute("data-jh-chip") || n.hasAttribute("data-jh-sec-anchor") ||
       n.hasAttribute("data-jh-ui") || n.hasAttribute("data-jh-overlay")));
  }
  function childIndexOf(parent, node){
    var i = 0;
    for (var k = 0; k < parent.childNodes.length; k++){
      var c = parent.childNodes[k];
      if (isOurs(c)) continue;
      if (c === node) return i;
      i++;
    }
    return -1;
  }
  function isCodeBlock(el){ return !!el && el.nodeName === "PRE"; }

  function ensureEditStyle(){
    if (document.getElementById("jh-edit-style")) return;
    var st = document.createElement("style"); st.id = "jh-edit-style";
    var hover = EDIT_BLOCKS.split(",").map(function(s){ return "html.jh-editmode " + s + ":hover"; }).join(",");
    // An empty block collapses to nothing, which would make a paragraph you just
    // added impossible to click back into.
    var empties = EDIT_BLOCKS.split(",").map(function(s){ return "html.jh-editmode " + s + ":empty"; }).join(",");
    st.textContent =
      hover + "{outline:1px dashed rgba(245,197,24,.8);outline-offset:2px;cursor:text}"
      + empties + "{min-height:1em}"
      + "html.jh-editmode [data-jh-edit],html.jh-editmode [data-jh-edit]:hover"
      + "{outline:2px solid #f5c518;outline-offset:2px;background:rgba(245,197,24,.08)}"
      + "html.jh-editmode [data-jh-edit]:empty::before"
      + "{content:'Type / for blocks';opacity:.45;pointer-events:none}"
      + "[data-jh-ui]{font:13px/1.4 ui-sans-serif,system-ui,sans-serif;color:#111}"
      + "#jh-slash{position:absolute;z-index:2147483646;background:#fff;border:1px solid #d8d8d8;"
      + "border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.16);padding:4px;min-width:180px}"
      + "#jh-slash div{padding:5px 10px;border-radius:5px;cursor:pointer}"
      + "#jh-slash div.sel{background:#f5c518}"
      + "#jh-grip{position:absolute;z-index:2147483645;width:18px;text-align:center;cursor:grab;"
      + "opacity:.35;user-select:none}"
      + "#jh-grip:hover{opacity:.9}"
      + "#jh-drop{position:absolute;z-index:2147483645;height:2px;background:#f5c518;pointer-events:none}"
      + "#jh-append{margin:24px 0 60px;padding:10px 0;opacity:.4;cursor:text}"
      + "html:not(.jh-editmode) #jh-append,html:not(.jh-editmode) #jh-grip{display:none}";
    (document.head||document.documentElement).appendChild(st);
  }

  // Text nodes of one block, under the same exclusions as buildText (our own
  // injected chips/anchors are not the author's text and must never be patched).
  function editTextNodes(el){
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null), out = [];
    while (w.nextNode()){
      var n = w.currentNode, p = n.parentNode;
      if (p && (p.nodeName === "SCRIPT" || p.nodeName === "STYLE")) continue;
      if (p && p.closest && p.closest("[data-jh-chip],[data-jh-sec-anchor],[data-jh-ui]")) continue;
      out.push(n);
    }
    return out;
  }

  // The block's inline content as runs, or null when it holds markup this editor
  // cannot describe. Refusing is the point: re-emitting a block we only half
  // understand would silently drop the part we didn't.
  function runsOf(el){
    var out = [], bad = false;
    (function walk(node, marks, href){
      for (var i = 0; i < node.childNodes.length; i++){
        var c = node.childNodes[i];
        if (isOurs(c)) continue;
        if (c.nodeType === 3){
          if (c.nodeValue !== "") out.push({ kind:"text", text:c.nodeValue, marks:marks.slice(), href:href || undefined });
          continue;
        }
        if (c.nodeType === 8) continue;
        if (c.nodeType !== 1){ bad = true; continue; }
        if (c.nodeName === "BR"){ out.push({ kind:"br" }); continue; }
        if (c.nodeName === "IMG"){
          out.push({ kind:"img", src:c.getAttribute("src") || "", alt:c.getAttribute("alt") || undefined });
          continue;
        }
        var m = MARK_OF[c.nodeName];
        if (m){ walk(c, marks.indexOf(m) === -1 ? marks.concat([m]) : marks, href); continue; }
        if (c.nodeName === "A"){ walk(c, marks, c.getAttribute("href") || href); continue; }
        bad = true;
      }
    })(el, [], null);
    return bad ? null : out;
  }

  function textOffsetIn(el, node, off){
    var nodes = editTextNodes(el), n = 0;
    for (var i = 0; i < nodes.length; i++){
      if (nodes[i] === node) return n + off;
      n += nodes[i].nodeValue.length;
    }
    return n;
  }
  function caretOffset(){
    if (!editEl) return 0;
    var s = window.getSelection();
    if (!s || !s.focusNode) return 0;
    return textOffsetIn(editEl, s.focusNode, s.focusOffset);
  }
  function setRange(node, off){
    try {
      var r = document.createRange(); r.setStart(node, off); r.collapse(true);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    } catch(e){}
  }
  function placeCaret(el, offset){
    var nodes = editTextNodes(el), n = 0;
    for (var i = 0; i < nodes.length; i++){
      var len = nodes[i].nodeValue.length;
      if (n + len >= offset){ setRange(nodes[i], Math.max(0, offset - n)); return; }
      n += len;
    }
    if (nodes.length) setRange(nodes[nodes.length-1], nodes[nodes.length-1].nodeValue.length);
    else setRange(el, 0);
  }
  function blockText(el){
    return editTextNodes(el).map(function(n){ return n.nodeValue; }).join("");
  }

  function beginEdit(el){
    if (editEl === el) return;
    // Re-entering a block supersedes any revert we still owed for its in-flight
    // save: the viewer's newer text wins over restoring the old one under their
    // cursor. Cleared BEFORE the commit below, which records the outgoing block's.
    editSent = null;
    if (commitEdit()) return;
    editEl = el;
    editSnap = {
      nodes: editTextNodes(el).map(function(n){ return { node:n, text:n.nodeValue }; }),
      html: el.innerHTML
    };
    editDirty = false;
    el.setAttribute("data-jh-edit","1");
    el.setAttribute("contenteditable","true");
    el.setAttribute("spellcheck","true");
    try { el.focus(); } catch(e){}
    reportEditSel();
  }

  function leaveEdit(el){
    el.removeAttribute("contenteditable");
    el.removeAttribute("data-jh-edit");
    el.removeAttribute("spellcheck");
  }

  // Restore the edited text nodes' original values (server rejected the patch).
  function revertSnap(snap){
    for (var i=0;i<snap.nodes.length;i++){
      var e = snap.nodes[i];
      try { if (e.node.isConnected) e.node.nodeValue = e.text; } catch(err){}
    }
  }

  function setDirty(on){
    on = !!on;
    if (on === editDirty) return;
    editDirty = on;
    send({type:"jh:dirty", on: on});
  }

  /**
   * Close the open block. Returns true when it handed off to an ops write, in
   * which case a reload is coming and the caller should not carry on with the
   * block it was holding.
   */
  function commitEdit(){
    if (!editEl) return false;
    // Markdown typed into the block resolves on the way out. Doing it here rather
    // than on Enter is what lets Enter always mean "split".
    if (tryInlineMarkdown()) return true;
    var el = editEl, snap = editSnap;
    editEl = null; editSnap = null;
    setDirty(false);
    leaveEdit(el);

    // A text patch can only express "this run of text became that one". If the
    // node list moved at all, the edit changed structure — restore the block's
    // markup (a view-local repair; the stored bytes were never touched) and say so.
    var live = editTextNodes(el);
    var structural = live.length !== snap.nodes.length;
    var changes = [];
    for (var i=0;i<snap.nodes.length && !structural;i++){
      if (live[i] !== snap.nodes[i].node){ structural = true; break; }
      var now = snap.nodes[i].node.nodeValue;
      if (now !== snap.nodes[i].text){
        // src/child name the same text node positionally, which is what the
        // shell's fallback needs when the text turns out not to be unique.
        var parent = snap.nodes[i].node.parentNode;
        changes.push({
          before: snap.nodes[i].text,
          after: now,
          src: srcOf(parent),
          child: parent ? childIndexOf(parent, snap.nodes[i].node) : -1
        });
      }
    }
    if (structural){
      try { el.innerHTML = snap.html; } catch(e){}
      send({type:"jh:editRejected", reason:"structural"});
      return false;
    }
    if (!changes.length) return false;
    editSent = snap;
    send({type:"jh:edit", changes: changes});
    return false;
  }

  function cancelEdit(){
    if (!editEl) return;
    var el = editEl, snap = editSnap;
    editEl = null; editSnap = null;
    setDirty(false);
    leaveEdit(el);
    // Discard everything, including a structural change the node-value revert
    // can't undo. View-local only — the stored bytes were never touched.
    try { el.innerHTML = snap.html; } catch(e){}
  }

  // Hand a set of ops to the shell. The block is closed first and no local DOM
  // change is made: the shell writes, then reloads the iframe against the result
  // and sends jh:focusBlock to put the caret back.
  function sendOps(ops, focus){
    if (!ops || !ops.length) return;
    closeBlock();
    hideSlash();
    send({ type:"jh:ops", ops: ops, focus: focus || null, scrollY: window.scrollY });
  }

  function refuse(reason){ send({type:"jh:editRejected", reason: reason}); }

  // --- marks ---------------------------------------------------------------

  function markAncestor(node, mark){
    for (var n = node; n && n !== document.body; n = n.parentNode){
      if (n.nodeType !== 1) continue;
      if (mark === "link" ? n.nodeName === "A" : MARK_OF[n.nodeName] === mark) return n;
    }
    return null;
  }

  function splitRun(run, text){
    return { kind:"text", text:text, marks:(run.marks || []).slice(), href:run.href };
  }

  // Apply (or clear) a mark across a character range of a block's runs. The range
  // is measured in the block's text, which is what a DOM selection gives us.
  // Toggling is by coverage: an already-fully-marked range clears.
  function markRuns(runs, a, b, mark, href){
    var out = [], pos = 0, covered = [];
    for (var i = 0; i < runs.length; i++){
      var r = runs[i];
      if (r.kind !== "text"){ out.push(r); continue; }
      var start = pos, end = pos + r.text.length; pos = end;
      if (end <= a || start >= b || a === b){ out.push(r); continue; }
      var cutA = Math.max(a, start) - start, cutB = Math.min(b, end) - start;
      if (cutA > 0) out.push(splitRun(r, r.text.slice(0, cutA)));
      var mid = splitRun(r, r.text.slice(cutA, cutB));
      out.push(mid); covered.push(mid);
      if (cutB < r.text.length) out.push(splitRun(r, r.text.slice(cutB)));
    }
    if (mark === "link"){
      covered.forEach(function(r){ if (href) r.href = href; else delete r.href; });
    } else {
      var all = covered.length > 0 && covered.every(function(r){ return (r.marks||[]).indexOf(mark) !== -1; });
      covered.forEach(function(r){
        var m = (r.marks || []).filter(function(x){ return x !== mark; });
        if (!all) m.push(mark);
        r.marks = m;
      });
    }
    return out.filter(function(r){ return r.kind !== "text" || r.text !== ""; });
  }

  function toggleMark(mark, href){
    if (!editEl || isCodeBlock(editEl)) return;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    if (range.collapsed) return;
    var src = srcOf(editEl);
    if (src == null){ refuse("markup"); return; }

    // The cheap, byte-precise case: adding a mark inside one text node of a block
    // with nothing else pending. Everything the author didn't touch — including
    // their entity spellings — stays exactly as written.
    var inMark = markAncestor(range.startContainer, mark);
    if (!editDirty && !inMark && mark !== "link" &&
        range.startContainer === range.endContainer && range.startContainer.nodeType === 3){
      var t = range.startContainer, parent = t.parentNode;
      var ci = childIndexOf(parent, t), psrc = srcOf(parent);
      if (psrc != null && ci >= 0){
        var v = t.nodeValue, s = range.startOffset, e = range.endOffset;
        var runs = [];
        if (s > 0) runs.push({ kind:"text", text:v.slice(0, s) });
        runs.push({ kind:"text", text:v.slice(s, e), marks:[mark] });
        if (e < v.length) runs.push({ kind:"text", text:v.slice(e) });
        sendOps([{ op:"setRuns", src:psrc, child:ci, before:v, runs:runs }],
                { src:src, offset: textOffsetIn(editEl, t, e) });
        return;
      }
    }

    // Clearing a mark, crossing element boundaries, or saving typed text at the
    // same time: re-emit the block's inline content, which carries all three.
    var whole = runsOf(editEl);
    if (!whole){ refuse("markup"); return; }
    var a = textOffsetIn(editEl, range.startContainer, range.startOffset);
    var b = textOffsetIn(editEl, range.endContainer, range.endOffset);
    var lo = Math.min(a, b), hi = Math.max(a, b);
    sendOps([{ op:"setInline", src:src, runs: markRuns(whole, lo, hi, mark, href) }],
            { src:src, offset: hi });
  }

  // --- block shape ---------------------------------------------------------

  // Ops that turn el into a block of kind key. rest is the text it should end up
  // with, or null to keep whatever it already holds.
  function blockOps(el, key, rest){
    var src = srcOf(el);
    if (src == null) return null;
    var parent = el.parentNode;
    var parentSrc = srcOf(parent);
    var inList = el.nodeName === "LI" && parent && (parent.nodeName === "UL" || parent.nodeName === "OL");
    var soleItem = inList && parent.querySelectorAll(":scope > li").length === 1;
    var runs = rest === null ? null : mdInline(rest);

    if (key === "hr") return { ops:[{ op:"replaceWith", src:src, blocks:[{ tag:"hr" }] }], focus:null };
    if (key === "pre"){
      return { ops:[{ op:"replaceWith", src:src, blocks:[{ tag:"pre", code: rest === null ? blockText(el) : rest }] }], focus:null };
    }
    if (key === "table"){
      return { ops:[{ op:"replaceWith", src:src, blocks:[{ tag:"table", rows:3, cols:3 }] }], focus:null };
    }
    if (key === "ul" || key === "ol"){
      if (inList){
        // Already a list item: switch the list's type rather than nesting another.
        if (parentSrc == null) return null;
        var swap = [{ op:"retag", src:parentSrc, tag:key }];
        if (runs) swap.push({ op:"setInline", src:src, runs:runs });
        return { ops:swap, focus:{ src:src, offset: runs ? rest.length : caretOffset() } };
      }
      var mk = [{ op:"retag", src:src, tag:"li" }, { op:"wrap", src:src, tags:[key] }];
      if (runs) mk.push({ op:"setInline", src:src, runs:runs });
      return { ops:mk, focus:{ src:src, offset: runs ? rest.length : caretOffset() } };
    }
    // A plain text block (paragraph, heading, quote).
    var out = [];
    if (inList){
      if (!soleItem){ refuse("list"); return null; }
      if (parentSrc == null) return null;
      out.push({ op:"unwrap", src:parentSrc });
    }
    out.push({ op:"retag", src:src, tag:key });
    if (runs) out.push({ op:"setInline", src:src, runs:runs });
    return { ops:out, focus:{ src:src, offset: rest === null ? caretOffset() : rest.length } };
  }

  function setBlockKind(key){
    if (!editEl) return;
    var plan = blockOps(editEl, key, null);
    if (plan) sendOps(plan.ops, plan.focus);
  }

  // The caret's text node and the offset inside it, which is what a byte-level
  // split needs. A caret parked on an element resolves to the child it names.
  function caretNode(){
    var s = window.getSelection();
    if (!s || !s.rangeCount) return null;
    var r = s.getRangeAt(0), n = r.startContainer, off = r.startOffset;
    if (n.nodeType !== 3){
      var kids = [];
      for (var i = 0; i < n.childNodes.length; i++) if (!isOurs(n.childNodes[i])) kids.push(n.childNodes[i]);
      var t = kids[off] || kids[kids.length - 1];
      if (!t || t.nodeType !== 3) return null;
      n = t; off = 0;
    }
    return { node:n, offset:off };
  }

  /** What a text node held when the block was opened — i.e. what the server has. */
  function snapshotTextOf(node){
    if (!editSnap) return null;
    for (var i = 0; i < editSnap.nodes.length; i++){
      if (editSnap.nodes[i].node === node) return editSnap.nodes[i].text;
    }
    return null;
  }

  // Marked runs for a stretch of typed text, or null when there is no markdown in
  // it. Scoped to ONE text node, so markup elsewhere in the block is never
  // flattened by reading the block as plain text.
  function mdRuns(text){
    if (!/[*\x60~[]|https?:\/\//.test(text)) return null;
    var runs = mdInline(text);
    return runs.some(function(r){ return (r.marks && r.marks.length) || r.href; }) ? runs : null;
  }

  /**
   * Close the open block without saving it. Called before a preview: extract-
   * Contents moves the node the caret sits in, and the focusout that follows
   * would otherwise be read as a text edit and store the truncated block.
   */
  function closeBlock(){
    // Clear the state BEFORE touching the element: removing contenteditable from
    // the focused block fires focusout synchronously, and that handler would
    // otherwise read it as a click-away and save the block a second time.
    var el = editEl;
    editEl = null; editSnap = null; editSent = null;
    if (el) leaveEdit(el);
    setDirty(false);
  }

  // Show the split before the server confirms it. Enter is the most-pressed
  // structural key there is, and a round trip of dead air on every one of them is
  // the difference between writing and waiting. The write stays authoritative —
  // the iframe reloads onto the stored bytes right after — and extractContents
  // splits the text node and clones the inline ancestors exactly the way splitAt
  // does, so the two agree and the reload is invisible.
  function previewSplit(el, node, offset, tag){
    try {
      var r = document.createRange();
      r.setStart(node, offset);
      r.setEndAfter(el.lastChild || el);
      var next = document.createElement(tag);
      next.appendChild(r.extractContents());
      el.parentNode.insertBefore(next, el.nextSibling);
    } catch(e){}
  }

  // Enter breaks the block at the caret. ALWAYS — it is never a save, and nothing
  // else is allowed to swallow it. At either end of the block the split leaves an
  // empty half, which is exactly what pressing Enter there should give you, so
  // there are no special cases and no way to end up with a block appended
  // somewhere you weren't looking.
  function splitBlock(){
    if (!editEl) return;
    var el = editEl, src = srcOf(el);
    if (src == null){ refuse("markup"); return; }
    var nextTag = el.nodeName === "LI" ? "li" : "p";
    var caret = caretNode();
    var parent = caret ? caret.node.parentNode : null;
    var container = parent ? srcOf(parent) : null;
    var child = parent ? childIndexOf(parent, caret.node) : -1;
    var before = caret ? snapshotTextOf(caret.node) : null;
    // Nothing to cut at: an empty block, or a caret we can't line up with the
    // stored bytes. Adding a block after this one is the honest fallback.
    if (!caret || container == null || child < 0 || before === null){
      sendOps([{ op:"insert", src:src, where:"after", blocks:[{ tag:nextTag, runs:[] }] }], null);
      return;
    }

    // Any OTHER run of the block that was typed into travels with the split, as
    // its own text op — separate text nodes, so separate byte ranges.
    var ops = [];
    for (var i = 0; editSnap && i < editSnap.nodes.length; i++){
      var e = editSnap.nodes[i];
      if (e.node === caret.node || e.node.nodeValue === e.text) continue;
      var p = e.node.parentNode, c = p ? childIndexOf(p, e.node) : -1, s = p ? srcOf(p) : null;
      if (s == null || c < 0) continue;
      ops.push({ op:"setRuns", src:s, child:c, before:e.text, runs:[{ kind:"text", text:e.node.nodeValue }] });
    }

    var live = caret.node.nodeValue;
    var head = live.slice(0, caret.offset), tail = live.slice(caret.offset);
    var marked = mdRuns(head);
    var op = { op:"splitAt", src:src, container:container, child:child, before:before, tag:nextTag };
    if (live === before && !marked){
      // Neither typed over nor reformatted: cut the stored bytes where they are,
      // and show it immediately, since the halves are what is already on screen.
      op.offset = caret.offset;
      ops.push(op);
      closeBlock();
      previewSplit(el, caret.node, caret.offset, nextTag);
    } else {
      // The node is being rewritten anyway, so the split carries the typing and
      // resolves markdown typed before the caret in the same write.
      op.head = marked || [{ kind:"text", text:head }];
      op.tail = [{ kind:"text", text:tail }];
      ops.push(op);
      closeBlock();
    }
    sendOps(ops, null);
  }

  function deleteBlock(el){
    var src = srcOf(el);
    if (src == null){ refuse("markup"); return; }
    var prev = el.previousElementSibling;
    var focus = prev && srcOf(prev) != null ? { src: srcOf(prev), offset: blockText(prev).length } : null;
    sendOps([{ op:"delete", src:src }], focus);
  }

  // --- markdown while typing ----------------------------------------------

  // A completed block prefix ("## ", "- ", "> ") converts the block and is eaten.
  function tryBlockShortcut(){
    if (!editEl || isCodeBlock(editEl)) return false;
    var hit = mdBlockShortcut(blockText(editEl));
    if (!hit) return false;
    var key = hit.kind === "heading" ? ("h" + Math.min(6, hit.level))
      : hit.kind === "quote" ? "blockquote" : hit.kind;
    var plan = blockOps(editEl, key, hit.rest);
    if (!plan) return false;
    sendOps(plan.ops, plan.focus);
    return true;
  }

  // Inline markdown resolves when the block commits, not per keystroke.
  function tryInlineMarkdown(){
    if (!editEl || isCodeBlock(editEl)) return false;
    var text = blockText(editEl);
    if (!/[*\x60~[]|https?:\/\//.test(text)) return false;
    var runs = mdInline(text);
    var marked = runs.some(function(r){ return (r.marks && r.marks.length) || r.href; });
    if (!marked) return false;
    var src = srcOf(editEl);
    if (src == null) return false;
    // Only safe on a block that is plain text: mdInline reads the block's TEXT,
    // so running it over a block that already has markup would flatten that markup.
    var whole = runsOf(editEl);
    if (!whole) return false;
    for (var i = 0; i < whole.length; i++){
      var r = whole[i];
      if (r.kind !== "text" || r.href || (r.marks && r.marks.length)) return false;
    }
    sendOps([{ op:"setInline", src:src, runs: runs }], { src:src, offset: text.length });
    return true;
  }

  // --- slash menu ----------------------------------------------------------

  var slashEl = null, slashSel = 0, slashFilter = "";
  var pendingLink = null;   // the range ⌘K was pressed over, applied when the shell replies

  function hideSlash(){
    if (slashEl && slashEl.parentNode) slashEl.parentNode.removeChild(slashEl);
    slashEl = null; slashFilter = "";
  }
  function slashMatches(){
    var f = slashFilter.toLowerCase();
    return SLASH_ITEMS.filter(function(it){
      return !f || it.label.toLowerCase().indexOf(f) === 0 || it.key.indexOf(f) === 0;
    });
  }
  function drawSlash(){
    var items = slashMatches();
    if (!items.length || !editEl){ hideSlash(); return; }
    if (!slashEl){
      slashEl = document.createElement("div");
      slashEl.id = "jh-slash";
      slashEl.setAttribute("data-jh-ui","1");
      document.body.appendChild(slashEl);
    }
    if (slashSel >= items.length) slashSel = items.length - 1;
    slashEl.innerHTML = "";
    items.forEach(function(it, i){
      var row = document.createElement("div");
      row.textContent = it.label;
      if (i === slashSel) row.className = "sel";
      row.addEventListener("mousedown", function(ev){ ev.preventDefault(); chooseSlash(it.key); });
      slashEl.appendChild(row);
    });
    var r = editEl.getBoundingClientRect();
    slashEl.style.top = (r.bottom + window.scrollY + 4) + "px";
    slashEl.style.left = (r.left + window.scrollX) + "px";
  }
  function chooseSlash(key){
    if (!editEl) return;
    var el = editEl;
    hideSlash();
    // The "/" and whatever was typed after it were only ever a command.
    var plan = blockOps(el, key, "");
    if (plan) sendOps(plan.ops, plan.focus);
  }

  // --- drag to reorder -----------------------------------------------------

  var grip = null, dropLine = null, dragEl = null, dropAt = null;

  function ensureGrip(){
    if (grip) return grip;
    grip = document.createElement("div");
    grip.id = "jh-grip";
    grip.setAttribute("data-jh-ui","1");
    grip.textContent = "⠿";
    grip.addEventListener("pointerdown", startDrag);
    document.body.appendChild(grip);
    return grip;
  }
  function showGrip(el){
    if (!editing || !el) return;
    var g = ensureGrip();
    var r = el.getBoundingClientRect();
    g.style.top = (r.top + window.scrollY) + "px";
    g.style.left = (r.left + window.scrollX - 22) + "px";
    g.__target = el;
  }
  function startDrag(ev){
    dragEl = grip && grip.__target;
    if (!dragEl) return;
    ev.preventDefault();
    if (!dropLine){
      dropLine = document.createElement("div");
      dropLine.id = "jh-drop";
      dropLine.setAttribute("data-jh-ui","1");
      document.body.appendChild(dropLine);
    }
    dropLine.style.display = "block";
    document.addEventListener("pointermove", onDrag, true);
    document.addEventListener("pointerup", endDrag, true);
  }
  function onDrag(ev){
    if (!dragEl) return;
    var over = document.elementFromPoint(ev.clientX, ev.clientY);
    var block = over && over.closest ? over.closest(EDIT_BLOCKS + ",ul,ol,table") : null;
    if (!block || block === dragEl || dragEl.contains(block)) return;
    var r = block.getBoundingClientRect();
    var below = ev.clientY > r.top + r.height / 2;
    dropAt = { el: block, below: below };
    dropLine.style.top = ((below ? r.bottom : r.top) + window.scrollY) + "px";
    dropLine.style.left = (r.left + window.scrollX) + "px";
    dropLine.style.width = r.width + "px";
  }
  function endDrag(){
    document.removeEventListener("pointermove", onDrag, true);
    document.removeEventListener("pointerup", endDrag, true);
    if (dropLine) dropLine.style.display = "none";
    var moving = dragEl, target = dropAt;
    dragEl = null; dropAt = null;
    if (!moving || !target) return;
    var src = srcOf(moving), parent = srcOf(target.el.parentNode);
    if (src == null || parent == null) return;
    var after = target.below ? srcOf(target.el) : srcOf(target.el.previousElementSibling);
    sendOps([{ op:"move", src:src, parent:parent, after: after == null ? null : after }], null);
  }

  // --- the trailing "add a paragraph" zone ---------------------------------

  function ensureAppendZone(){
    if (document.getElementById("jh-append") || !document.body) return;
    var z = document.createElement("div");
    z.id = "jh-append";
    z.setAttribute("data-jh-ui","1");
    z.textContent = "Click to add a paragraph";
    z.addEventListener("click", function(){
      var src = srcOf(document.body);
      if (src != null){
        sendOps([{ op:"insert", src:src, where:"append", blocks:[{ tag:"p", runs:[] }] }], null);
        return;
      }
      // A document with no <body> tag has nothing to append INTO, so append after
      // its last element instead.
      var all = document.querySelectorAll("[data-jh-src]");
      for (var i = all.length - 1; i >= 0; i--){
        if (isOurs(all[i])) continue;
        sendOps([{ op:"insert", src:srcOf(all[i]), where:"after", blocks:[{ tag:"p", runs:[] }] }], null);
        return;
      }
    });
    document.body.appendChild(z);
  }

  // --- state the shell's toolbar and status pill render --------------------

  function reportEditSel(){
    if (!editing || !editEl){ send({type:"jh:editSel", active:false}); return; }
    var sel = window.getSelection();
    var marks = [], href = null;
    for (var n = sel && sel.focusNode; n && n !== editEl; n = n.parentNode){
      if (!n.nodeName) break;
      var m = MARK_OF[n.nodeName];
      if (m && marks.indexOf(m) === -1) marks.push(m);
      if (n.nodeName === "A") href = n.getAttribute("href");
    }
    // A collapsed caret has no rectangle of its own, so fall back to the block's:
    // the toolbar still needs a place to sit while you change the block's type.
    var rect = null;
    try {
      var box = (sel && sel.rangeCount && !sel.isCollapsed)
        ? sel.getRangeAt(0).getBoundingClientRect()
        : editEl.getBoundingClientRect();
      rect = { top: box.top + window.scrollY, left: box.left, right: box.right,
               bottom: box.bottom + window.scrollY, viewTop: box.top,
               collapsed: !(sel && sel.rangeCount && !sel.isCollapsed) };
    } catch(e){}
    send({
      type:"jh:editSel", active:true, marks:marks, href:href, rect:rect,
      tag: editEl.nodeName.toLowerCase(), code: isCodeBlock(editEl)
    });
  }

  function reportWords(){
    if (!document.body) return;
    // editTextNodes already steps over our injected UI, so this counts the
    // author's text and not the chrome we added around it.
    var t = editTextNodes(document.body).map(function(n){ return n.nodeValue; }).join(" ");
    var words = t.split(/\s+/).filter(function(w){ return w.length; }).length;
    send({type:"jh:words", words: words, chars: t.replace(/\s+/g, " ").length});
  }

  // --- mode ----------------------------------------------------------------

  function setEditMode(on){
    on = !!on;
    if (on === editing) return;
    editing = on;
    if (on){
      ensureEditStyle();
      ensureAppendZone();
      // Unwrap highlight segments first: they split text nodes mid-run, and an
      // edit must diff the author's nodes, not our paint.
      clearHighlights();
      hidePop();
      try { var s = window.getSelection(); if (s) s.removeAllRanges(); } catch(e){}
      send({type:"jh:selectionCleared"});
      document.documentElement.classList.add("jh-editmode");
      reportWords();
      if (pendingFocusReq){
        var f = pendingFocusReq; pendingFocusReq = null;
        focusBlock(f.src, f.offset);
      }
    } else {
      pendingFocusReq = null;
      commitEdit();
      hideSlash();
      document.documentElement.classList.remove("jh-editmode");
      send({type:"jh:editSel", active:false});
      paint();
    }
  }

  // After a reload, put the viewer back where they were.
  //
  // The shell sends this from its jh:ready handler, but it re-sends edit mode
  // from an effect that runs AFTER that handler — so on a reload this reliably
  // arrives while edit mode is still off. Hold the request until the mode is back
  // rather than dropping the caret, which would cost the viewer a click after
  // every Enter.
  var pendingFocusReq = null;
  function focusBlock(src, offset, scrollY){
    if (typeof scrollY === "number"){ try { window.scrollTo(0, scrollY); } catch(e){} }
    if (!editing){ pendingFocusReq = { src:src, offset:offset }; return; }
    var el = elBySrc(src);
    if (!el) return;
    beginEdit(el);
    placeCaret(el, typeof offset === "number" ? offset : 0);
    try { el.scrollIntoView({block:"nearest"}); } catch(e){}
  }

  // The shell collected a URL for the range ⌘K was pressed over.
  function applyPendingLink(href){
    var range = pendingLink; pendingLink = null;
    if (!range || !editEl) return;
    try {
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
    } catch(e){ return; }
    toggleMark("link", href || null);
  }

  document.addEventListener("click", function(ev){
    if (!editing) return;
    var t = ev.target;
    if (t && t.closest && t.closest("[data-jh-ui]")) return;
    // Links are text to edit here, not navigation — the iframe must not leave.
    if (t && t.closest && t.closest("a[href]")) ev.preventDefault();
    var el = t && t.closest && t.closest(EDIT_BLOCKS);
    if (!el){ commitEdit(); hideSlash(); return; }
    beginEdit(el);
  }, true);

  document.addEventListener("mouseover", function(ev){
    if (!editing) return;
    var el = ev.target && ev.target.closest ? ev.target.closest(EDIT_BLOCKS) : null;
    if (el) showGrip(el);
  }, true);

  // Touch: a long press opens a block for editing, turning edit mode on first if
  // it is off. A phone has no hover, and the shell's pencil is a long way from
  // the paragraph you meant.
  var pressTimer = null;
  document.addEventListener("touchstart", function(ev){
    if (!editAllowed) return;
    var el = ev.target && ev.target.closest ? ev.target.closest(EDIT_BLOCKS) : null;
    if (!el) return;
    pressTimer = setTimeout(function(){
      pressTimer = null;
      if (!editing) send({type:"jh:requestEditMode"});
      setEditMode(true);
      beginEdit(el);
    }, 550);
  }, {passive:true});
  ["touchend","touchmove","touchcancel"].forEach(function(n){
    document.addEventListener(n, function(){ if (pressTimer){ clearTimeout(pressTimer); pressTimer = null; } }, {passive:true});
  });

  document.addEventListener("keydown", function(ev){
    if (!editEl) return;
    var meta = ev.metaKey || ev.ctrlKey;

    if (slashEl){
      var items = slashMatches();
      if (ev.key === "ArrowDown"){ ev.preventDefault(); slashSel = (slashSel + 1) % items.length; drawSlash(); return; }
      if (ev.key === "ArrowUp"){ ev.preventDefault(); slashSel = (slashSel - 1 + items.length) % items.length; drawSlash(); return; }
      if (ev.key === "Enter"){ ev.preventDefault(); if (items[slashSel]) chooseSlash(items[slashSel].key); return; }
      if (ev.key === "Escape"){ ev.preventDefault(); hideSlash(); return; }
    }

    if (meta && !ev.altKey){
      var k = ev.key.toLowerCase();
      if (k === "b"){ ev.preventDefault(); toggleMark("strong"); return; }
      if (k === "i"){ ev.preventDefault(); toggleMark("em"); return; }
      if (k === "e"){ ev.preventDefault(); toggleMark("code"); return; }
      if (k === "x" && ev.shiftKey){ ev.preventDefault(); toggleMark("del"); return; }
      if (k === "k"){
        ev.preventDefault();
        var sel = window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed){
          pendingLink = sel.getRangeAt(0).cloneRange();
          var existing = markAncestor(sel.focusNode, "link");
          send({type:"jh:linkPrompt", href: existing ? existing.getAttribute("href") : null});
        }
        return;
      }
      if (ev.shiftKey && (k === "7" || k === "8")){
        ev.preventDefault(); setBlockKind(k === "7" ? "ol" : "ul"); return;
      }
      if (ev.shiftKey && ev.key === "."){ ev.preventDefault(); setBlockKind("blockquote"); return; }
    }
    if (meta && ev.altKey && /^[0-6]$/.test(ev.key)){
      ev.preventDefault();
      setBlockKind(ev.key === "0" ? "p" : "h" + ev.key);
      return;
    }

    if (ev.key === "Tab"){
      var cell = editEl.closest("td,th");
      if (cell){
        ev.preventDefault();
        var step = ev.shiftKey ? -1 : 1;
        var cells = Array.prototype.slice.call(cell.closest("table").querySelectorAll("td,th"));
        var next = cells[cells.indexOf(cell) + step];
        if (next) beginEdit(next);
        else if (step === 1){
          var rsrc = srcOf(cell.closest("tr"));
          if (rsrc != null) sendOps([{ op:"insertRow", src:rsrc }], null);
        }
        return;
      }
      if (editEl.nodeName === "LI"){
        ev.preventDefault();
        var lsrc = srcOf(editEl);
        if (lsrc != null) sendOps([{ op: ev.shiftKey ? "outdent" : "indent", src:lsrc }], { src:lsrc, offset: caretOffset() });
        return;
      }
    }

    if (ev.key === "Enter"){
      if (isCodeBlock(editEl)) return;   // a code block keeps its newlines
      ev.preventDefault();
      if (meta){ commitEdit(); return; }
      // A completed block prefix ("## ") is a command with no content to split.
      if (tryBlockShortcut()) return;
      splitBlock();
      return;
    }

    if (ev.key === "Backspace" && !isCodeBlock(editEl)){
      var sel2 = window.getSelection();
      if (sel2 && sel2.isCollapsed && caretOffset() === 0 && blockText(editEl) === ""){
        ev.preventDefault();
        deleteBlock(editEl);
        return;
      }
    }

    if (ev.key === "Escape"){ ev.preventDefault(); hideSlash(); cancelEdit(); }
  });

  document.addEventListener("input", function(){
    if (!editEl) return;
    setDirty(true);
    if (isCodeBlock(editEl)) return;
    var text = blockText(editEl);
    // "/" on an otherwise empty block opens the block menu; keep filtering as the
    // author narrows it, and give up as soon as it stops matching.
    if (text.charAt(0) === "/"){ slashFilter = text.slice(1); slashSel = 0; drawSlash(); }
    else hideSlash();
    // A block shortcut fires the moment its prefix is complete.
    if (/^(#{1,6} |[-*+] |\d+[.)] |> )$/.test(text)) tryBlockShortcut();
  });

  document.addEventListener("paste", function(ev){
    if (!editEl) return;
    ev.preventDefault();
    var t = "";
    try { t = ((ev.clipboardData || window.clipboardData).getData("text/plain") || ""); } catch(e){}
    if (!t) return;
    // A multi-line paste is markdown: turn it into real blocks rather than
    // flattening someone's outline into a single paragraph.
    if (!isCodeBlock(editEl) && /\n/.test(t.trim())){
      var blocks = mdBlocks(t);
      var psrc = srcOf(editEl);
      if (blocks.length && psrc != null){
        var ops = [{ op:"insert", src:psrc, where:"after", blocks: blocks }];
        if (blockText(editEl) === "") ops.push({ op:"delete", src:psrc });
        sendOps(ops, null);
        return;
      }
    }
    try { document.execCommand("insertText", false, t.replace(/\s*\n+\s*/g, " ")); } catch(e){}
  });

  document.addEventListener("focusout", function(ev){
    // Click-away (including onto the shell's chrome) saves.
    if (editEl && ev.target === editEl) commitEdit();
  });

  document.addEventListener("selectionchange", function(){
    if (editing) reportEditSel();
  });

  // ---- selection → anchor ----
  function anchorFromSelection(sel){
    // Derive exact/prefix/suffix from the SAME clean text model as anchor
    // resolution (buildText skips SCRIPT/STYLE and our own chips). Using raw
    // Range.toString() over document.body would sweep the injected overlay
    // <script> source into the suffix for selections near the doc end, which
    // poisons tier-2 quote re-finding. Map the selection's DOM endpoints to
    // offsets in the clean text, then slice context from there.
    var r = sel.getRangeAt(0);
    var tm = buildText();
    function offsetOf(container, domOffset){
      for (var i=0;i<tm.nodes.length;i++){
        if (tm.nodes[i].node === container) return tm.nodes[i].start + domOffset;
      }
      // Element (non-text) container: fall back to the first clean text node
      // that follows it in document order; else end of text.
      for (var j=0;j<tm.nodes.length;j++){
        var rel = container.compareDocumentPosition(tm.nodes[j].node);
        if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return tm.nodes[j].start;
      }
      return tm.full.length;
    }
    var s = offsetOf(r.startContainer, r.startOffset);
    var e = offsetOf(r.endContainer, r.endOffset);
    if (e < s) { var t = s; s = e; e = t; }
    var exact = (e > s) ? tm.full.slice(s, e) : sel.toString();
    return { exact: exact, prefix: tm.full.slice(Math.max(0, s-32), s), suffix: tm.full.slice(e, e+32) };
  }
  var selectionTimer = null;
  function fromOverlayChrome(ev){
    var t = ev && ev.target;
    return !!(t && t.closest && (t.closest("[data-jh-chip]") || t.closest(".jh-pop")));
  }
  function reportSelection(){
    // In edit mode the caret IS the selection — reporting it would pop the
    // comment toolbar over the text being typed.
    if (editing) return;
    try {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed || !sel.toString().trim()){ send({type:"jh:selectionCleared"}); return; }
      var anchor = anchorFromSelection(sel);
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      send({type:"jh:selection", anchor: anchor, rect: {
        top: rect.top + window.scrollY, left: rect.left, right: rect.right, bottom: rect.bottom + window.scrollY,
        viewTop: rect.top
      }});
    } catch(e) {
      send({type:"jh:selectionCleared"});
    }
  }
  function queueSelectionReport(delay){
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(function(){
      selectionTimer = null;
      reportSelection();
    }, delay);
  }
  document.addEventListener("mouseup", function(ev){
    if (fromOverlayChrome(ev)) return;
    queueSelectionReport(10);
  });
  document.addEventListener("keyup", function(ev){
    if (fromOverlayChrome(ev)) return;
    queueSelectionReport(10);
  });
  document.addEventListener("touchend", function(ev){
    if (fromOverlayChrome(ev)) return;
    queueSelectionReport(80);
  }, {passive:true});
  document.addEventListener("pointerup", function(ev){
    if (fromOverlayChrome(ev)) return;
    queueSelectionReport(30);
  });
  document.addEventListener("selectionchange", function(){
    queueSelectionReport(120);
  });

  window.addEventListener("message", function(ev){
    var d = ev.data; if (!d || typeof d !== "object") return;
    if (d.type === "jh:anchors"){ anchors = Array.isArray(d.anchors) ? d.anchors : []; paint(); consumePendingFocus(); }
    else if (d.type === "jh:reactions"){
      rxGroups = Array.isArray(d.groups) ? d.groups : [];
      me = d.me || me;
      if (d.avatars) window.__jhAvatars = d.avatars;
      paint();
    }
    else if (d.type === "jh:active"){
      // rail → doc hover sync: light the span of the hovered card (comment id) /
      // chip group. id may be a number (comment) or "r:<sig>".
      var key = (d.id == null) ? null : (typeof d.id === "number" ? "c:"+d.id : String(d.id));
      setHover(key);
    }
    else if (d.type === "jh:focus"){
      // rail → doc: focus a key (card clicked), or null to clear. Either way this
      // supersedes a not-yet-resolved section scroll (a comment and a section are
      // mutually exclusive selections), so cancel pendingSection.
      pendingSection = null;
      if (d.key == null) { pendingFocusScroll = null; clearFocus(); }
      else {
        var ck = byKey[d.key];
        setFocus(d.key, ck ? coverKeysOf(d.key) : [d.key]);
        // If the segment isn't painted yet (e.g. a resolved thread whose anchor
        // arrives in the jh:anchors that FOLLOWS this focus, once showResolved
        // flips), defer the scroll to the next paint instead of dropping it.
        if (ck) { pendingFocusScroll = null; scrollToKey(d.key); }
        else pendingFocusScroll = d.key;
      }
    }
    else if (d.type === "jh:scrollTo"){ var sk = (typeof d.id === "number") ? "c:"+d.id : String(d.id); scrollToKey(sk); }
    else if (d.type === "jh:sections"){ sections = Array.isArray(d.sections) ? d.sections : []; applySections(); }
    else if (d.type === "jh:scrollToSection"){ scrollToSection(String(d.id)); }
    else if (d.type === "jh:clearSelection"){ var s=window.getSelection(); if(s) s.removeAllRanges(); }
    else if (d.type === "jh:themeMode"){
      forcedScheme = (d.mode === "dark" || d.mode === "light") ? d.mode : null;
      applyDocScheme();
      sampleTheme(); // re-read colors so the chrome + highlight follow the forced doc theme
    }
    else if (d.type === "jh:editMode"){
      editAllowed = !!d.allowed;
      setEditMode(d.on);
    }
    else if (d.type === "jh:focusBlock"){ focusBlock(d.src, d.offset, d.scrollY); }
    else if (d.type === "jh:applyLink"){ applyPendingLink(d.href); }
    else if (d.type === "jh:cmd"){
      // The shell's format toolbar. Its buttons suppress focus loss on mousedown,
      // so the block is still open and the selection still live when this lands.
      if (d.name === "mark") toggleMark(d.arg);
      else if (d.name === "block") setBlockKind(d.arg);
      else if (d.name === "linkPrompt"){
        var lsel = window.getSelection();
        if (lsel && lsel.rangeCount && !lsel.isCollapsed){
          pendingLink = lsel.getRangeAt(0).cloneRange();
          var have = markAncestor(lsel.focusNode, "link");
          send({type:"jh:linkPrompt", href: have ? have.getAttribute("href") : null});
        }
      }
    }
    else if (d.type === "jh:editResult"){
      // The shell reports what the server did with the patch we sent. Accepted →
      // the DOM already shows the new text, nothing to do. Rejected → put the
      // author's text back so the view never disagrees with the stored bytes.
      var sent = editSent; editSent = null;
      if (sent && !d.ok){ revertSnap(sent); if (!editing) paint(); }
    }
    else if (d.type === "jh:ping"){ sendReady(); }
  });

  // covering keys that overlap a given key's span (for cycle context when focusing
  // from the rail) — any item whose range intersects this item's range.
  function coverKeysOf(key){
    var it = byKey[key] && byKey[key].item; if (!it) return [key];
    var ks = items.filter(function(o){ return o.start < it.end && o.end > it.start; }).map(function(o){ return o.key; });
    return orderBySize(ks);
  }

  /**
   * Announce readiness, tagged with the ?r= of THIS load. A reload leaves the old
   * document alive until the new one commits, so the shell's readiness ping gets
   * answered by the outgoing overlay first; without the tag the shell would hand
   * the restored caret to a document that is about to be thrown away.
   */
  function sendReady(){
    var r = "";
    try { r = new URLSearchParams(location.search).get("r") || ""; } catch(e){}
    send({type:"jh:ready", r: r});
  }

  var ticking = false;
  window.addEventListener("scroll", function(){ if(ticking) return; ticking=true; requestAnimationFrame(function(){ reportPositions(); ticking=false; }); }, {passive:true});
  window.addEventListener("resize", function(){ paint(); });

  sendReady();
  // Capture the authored theme NOW, while the doc is still unforced, so we can keep
  // reporting it once a forced theme is painted over the document. Don't emit yet — the
  // shell's jh:themeMode reply drives the first emit with the viewer's mode known (no
  // authored flash in the chrome). The load + settle re-emits are the safety net for
  // late-applied CSS and for any host that never sends jh:themeMode.
  authoredTheme = sampleAuthored();
  try { ensureStyle(); if (document.documentElement) document.documentElement.classList.toggle("jh-dark", effectiveDark()); } catch(e){}
  window.addEventListener("load", sampleTheme);
  setTimeout(sampleTheme, 400);
})();
`;
