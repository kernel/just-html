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
//                     { type:"jh:clearSelection" }
//   overlay → shell:  { type:"jh:ready" }
//                     { type:"jh:positions", positions:{ [id]: yTopPx }, docHeight }
//                          (comment highlight y in doc space; docHeight sizes the
//                          shell's iframe so the parent page owns the one scrollbar)
//                     { type:"jh:selection", anchor:{exact,prefix,suffix}, rect:{...} }
//                     { type:"jh:selectionCleared" }
//                     { type:"jh:focus", key, keys }      (a segment was clicked: focused key + full covering set)
//                     { type:"jh:hlHover", id } / { type:"jh:hlHoverOut" }
//                     { type:"jh:reactionToggle", anchor:{exact,prefix,suffix}, emoji } (chip click)
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
  var lastClickKeys = null;  // covering set of the last focus click (for cycle)
  var lastClickPos = -1;     // doc-text offset of the last focus click (cycle reset on move)

  function send(msg){ try { parent.postMessage(msg, "*"); } catch(e){} }
  function esc(s){ return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  // ---- adaptive chrome: sample the doc's effective colors (jh:theme) ----
  // Only the overlay (inside the sandboxed, opaque-origin iframe) can read the
  // doc's COMPUTED colors; the shell can't reach across the origin. We sample
  // bg/fg/accent via getComputedStyle and post {bg, fg, accent, isDark} so the
  // shell can derive variant-D dark chrome (lib/docs/theme.ts buildChromePalette).
  // Cheap; re-emitted on ready / load / a short settle to catch late CSS.
  // isDark uses WCAG relative luminance with a small hysteresis dead-band so a
  // mid-tone bg doesn't flip-flop across re-emits.
  var lastDark = null; // hysteresis memory across re-emits
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
  function sampleTheme(){
    try {
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
      // hysteresis dead-band around 0.4: once dark, stay dark until >0.46; once
      // light, stay light until <0.34. First sample uses the bare 0.4 threshold.
      var dark;
      if (lastDark === true) dark = lum < 0.46;
      else if (lastDark === false) dark = lum < 0.34;
      else dark = lum < 0.4;
      lastDark = dark;

      // toggle the dark-highlight stylesheet branch (needs the style present).
      // Keyed on the doc's SAMPLED darkness — never the chrome theme — because the
      // highlight is painted ON the document, so it must contrast with the page's
      // real background regardless of what the viewer picked for the rail chrome.
      try { ensureStyle(); if (document.documentElement) document.documentElement.classList.toggle("jh-dark", !!dark); } catch(e){}

      send({ type:"jh:theme",
        bg: "rgb("+Math.round(bgRgb[0])+","+Math.round(bgRgb[1])+","+Math.round(bgRgb[2])+")",
        fg: "rgb("+Math.round(fgRgb[0])+","+Math.round(fgRgb[1])+","+Math.round(fgRgb[2])+")",
        accent: accStr || undefined,
        isDark: dark,
        gradient: gradient });
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
      // skip text inside our own chips so reaction counts never become anchorable text
      if (p && p.closest && p.closest("[data-jh-chip]")) continue;
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

  // ---- segment painting (the B14 core) ----
  function paint(){
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
      el.className = "d"+depth; // reset base depth class
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
    send({type:"jh:positions", positions: pos, docHeight: document.documentElement.scrollHeight});
  }

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
    try {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed || !sel.toString().trim()){ send({type:"jh:selectionCleared"}); return; }
      var anchor = anchorFromSelection(sel);
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      send({type:"jh:selection", anchor: anchor, rect: {
        top: rect.top + window.scrollY, left: rect.left, right: rect.right, bottom: rect.bottom + window.scrollY
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
    if (d.type === "jh:anchors"){ anchors = Array.isArray(d.anchors) ? d.anchors : []; paint(); }
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
      // rail → doc: focus a key (card clicked). null clears. No scrolling here —
      // the parent page owns the scrollbar (this document never scrolls), and the
      // shell scrolls the window to the highlight itself.
      if (d.key == null) clearFocus();
      else { var ck = byKey[d.key]; setFocus(d.key, ck ? coverKeysOf(d.key) : [d.key]); }
    }
    else if (d.type === "jh:clearSelection"){ var s=window.getSelection(); if(s) s.removeAllRanges(); }
    else if (d.type === "jh:ping"){ send({type:"jh:ready"}); }
  });

  // covering keys that overlap a given key's span (for cycle context when focusing
  // from the rail) — any item whose range intersects this item's range.
  function coverKeysOf(key){
    var it = byKey[key] && byKey[key].item; if (!it) return [key];
    var ks = items.filter(function(o){ return o.start < it.end && o.end > it.start; }).map(function(o){ return o.key; });
    return orderBySize(ks);
  }

  var ticking = false;
  window.addEventListener("scroll", function(){ if(ticking) return; ticking=true; requestAnimationFrame(function(){ reportPositions(); ticking=false; }); }, {passive:true});
  window.addEventListener("resize", function(){ paint(); });

  send({type:"jh:ready"});
  // Adaptive chrome: emit theme on ready, again on window.load, and once after a
  // short settle to catch late-applied CSS. Cheap to re-emit; hysteresis guards
  // flip-flop. Doesn't disturb any existing overlay behavior.
  sampleTheme();
  window.addEventListener("load", function(){ sampleTheme(); reportPositions(); });
  setTimeout(sampleTheme, 400);
  // The shell sizes its iframe to docHeight (single page scrollbar), so content
  // growth it can't observe from outside — late images, fonts, dynamic docs —
  // must be re-reported from in here.
  if (typeof ResizeObserver !== "undefined"){
    var ro = new ResizeObserver(function(){
      if (ticking) return; ticking = true;
      requestAnimationFrame(function(){ reportPositions(); ticking = false; });
    });
    if (document.body) ro.observe(document.body);
    else window.addEventListener("DOMContentLoaded", function(){ if (document.body) ro.observe(document.body); });
  }
})();
`;
