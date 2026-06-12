// Overlay script injected into the SANDBOXED iframe (/d/:slug/raw?overlay=1),
// and ONLY when the shell embeds it (the shell appends overlay=1; direct /raw
// fetches stay byte-pristine — birthday.md "Production architecture").
//
// The user HTML stays origin-less in the sandbox. This script runs INSIDE that
// sandbox and talks to the shell (the React rail) only via postMessage:
//
//   shell → overlay:  { type:"jh:anchors", anchors:[{id, exact, prefix, suffix, resolved}] }
//                     { type:"jh:active", id }            (hover/pin highlight)
//                     { type:"jh:scrollTo", id }
//   overlay → shell:  { type:"jh:ready" }
//                     { type:"jh:positions", positions:{ [id]: yTopPx } }  (highlight y in doc coords)
//                     { type:"jh:selection", anchor:{exact,prefix,suffix}, rect:{top,left,right,bottom} }
//                     { type:"jh:selectionCleared" }
//                     { type:"jh:hlClick", id }
//
// The overlay resolves W3C text-quotes against the live DOM (prefix/suffix
// disambiguation), paints google-docs highlights, and reports y-positions so the
// shell can align rail cards (no-overlap clamping is done in the shell). It never
// reads cookies (sandbox = opaque origin) and only accepts messages from the
// parent window. The shell verifies the iframe origin is "null" (sandboxed).

export const OVERLAY_SCRIPT = String.raw`
(function(){
  "use strict";
  if (window.__jhOverlay) return; window.__jhOverlay = true;

  var anchors = [];          // [{id, exact, prefix, suffix, resolved}]
  var ranges = {};           // id -> Range (resolved)
  var activeId = null;

  function send(msg){ try { parent.postMessage(msg, "*"); } catch(e){} }

  // ---- text-content walker (anchor resolution against the live DOM) ----
  function buildText(){
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var nodes = [], full = "";
    while (walker.nextNode()){
      var n = walker.currentNode;
      // skip script/style text
      var p = n.parentNode;
      if (p && (p.nodeName === "SCRIPT" || p.nodeName === "STYLE")) continue;
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
  function squash(s){ return (s||"").replace(/\s+/g," "); }

  // Score occurrences of exact by prefix/suffix agreement; refuse ambiguity.
  function findRange(tx, a){
    var full = tx.full, nodes = tx.nodes;
    var occ = [], from = 0, idx;
    while ((idx = full.indexOf(a.exact, from)) !== -1){ occ.push(idx); from = idx + 1; if (occ.length>5000) break; }
    if (occ.length === 0){
      // tolerant: whitespace-normalized retry
      var nf = squash(full), ne = squash(a.exact), ni = nf.indexOf(ne);
      if (ni < 0) return null;
      // map normalized index back to a raw index (approximate, good enough to paint)
      var raw = 0, nrm = 0;
      while (nrm < ni && raw < full.length){ if (/\s/.test(full[raw])){ while(/\s/.test(full[raw])) raw++; nrm++; } else { raw++; nrm++; } }
      var end = raw, c = 0, neLen = ne.length;
      while (c < neLen && end < full.length){ if (/\s/.test(full[end])){ while(/\s/.test(full[end])) end++; c++; } else { end++; c++; } }
      occ = [raw]; var aLen = end - raw;
      return mkRange(nodes, raw, aLen);
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
      if (tie && best<=0) return null; // ambiguous, no disambiguator
      pick = bestIdx;
    }
    return mkRange(nodes, pick, a.exact.length);
  }
  function mkRange(nodes, start, len){
    var a = locate(nodes, start), b = locate(nodes, start+len);
    if (!a || !b) return null;
    try { var r = document.createRange(); r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); return r; } catch(e){ return null; }
  }

  function clearHighlights(){
    var marks = document.querySelectorAll("span[data-jh-hl]");
    marks.forEach(function(m){ var p=m.parentNode; while(m.firstChild) p.insertBefore(m.firstChild,m); p.removeChild(m); });
    if (document.body) document.body.normalize();
    ranges = {};
  }
  function ensureStyle(){
    if (document.getElementById("jh-overlay-style")) return;
    var st = document.createElement("style"); st.id = "jh-overlay-style";
    st.textContent = "span[data-jh-hl]{background:#fff3bf;border-bottom:1px solid #f1d96b;cursor:pointer;transition:background .12s}"
      + "span[data-jh-hl].jh-active{background:#ffe089}"
      + "span[data-jh-hl][data-jh-resolved=\"1\"]{}";
    (document.head||document.documentElement).appendChild(st);
  }
  function paint(){
    ensureStyle();
    clearHighlights();
    var tx = buildText();
    anchors.forEach(function(a){
      if (!a.exact) return;
      var r = findRange(tx, a);
      if (!r) return;
      try {
        var span = document.createElement("span");
        span.setAttribute("data-jh-hl", a.id);
        span.setAttribute("data-jh-resolved","1");
        span.appendChild(r.extractContents());
        r.insertNode(span);
        document.body.normalize();
        ranges[a.id] = span;
        span.addEventListener("click", function(ev){ ev.stopPropagation(); send({type:"jh:hlClick", id:a.id}); });
        span.addEventListener("mouseenter", function(){ send({type:"jh:hlHover", id:a.id}); });
      } catch(e){}
      // rebuild text after each insert so subsequent offsets stay valid
      tx = buildText();
    });
    reportPositions();
  }
  function reportPositions(){
    var pos = {};
    Object.keys(ranges).forEach(function(id){
      var el = ranges[id]; if (!el) return;
      var rect = el.getBoundingClientRect();
      pos[id] = rect.top + window.scrollY;
    });
    send({type:"jh:positions", positions: pos, docHeight: document.documentElement.scrollHeight});
  }
  function setActive(id){
    if (activeId && ranges[activeId]) ranges[activeId].classList.remove("jh-active");
    activeId = id;
    if (id && ranges[id]) ranges[id].classList.add("jh-active");
  }
  function scrollTo(id){
    var el = ranges[id]; if (!el) return;
    el.scrollIntoView({block:"center", behavior:"smooth"});
    setActive(id);
  }

  // ---- selection → anchor ----
  function anchorFromSelection(sel){
    var r = sel.getRangeAt(0);
    var pre = document.createRange(); pre.setStart(document.body,0); pre.setEnd(r.startContainer, r.startOffset);
    var post = document.createRange(); post.setStart(r.endContainer, r.endOffset); post.setEnd(document.body, document.body.childNodes.length);
    return { exact: sel.toString(), prefix: pre.toString().slice(-32), suffix: post.toString().slice(0,32) };
  }
  document.addEventListener("mouseup", function(){
    setTimeout(function(){
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed || !sel.toString().trim()){ send({type:"jh:selectionCleared"}); return; }
      var anchor = anchorFromSelection(sel);
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      send({type:"jh:selection", anchor: anchor, rect: {
        top: rect.top + window.scrollY, left: rect.left, right: rect.right, bottom: rect.bottom + window.scrollY,
        viewTop: rect.top
      }});
    }, 10);
  });

  window.addEventListener("message", function(ev){
    var d = ev.data; if (!d || typeof d !== "object") return;
    if (d.type === "jh:anchors"){ anchors = Array.isArray(d.anchors) ? d.anchors : []; paint(); }
    else if (d.type === "jh:active"){ setActive(d.id || null); }
    else if (d.type === "jh:scrollTo"){ scrollTo(d.id); }
    else if (d.type === "jh:clearSelection"){ var s=window.getSelection(); if(s) s.removeAllRanges(); }
    else if (d.type === "jh:ping"){ send({type:"jh:ready"}); }
  });

  var ticking = false;
  window.addEventListener("scroll", function(){ if(ticking) return; ticking=true; requestAnimationFrame(function(){ reportPositions(); ticking=false; }); }, {passive:true});
  window.addEventListener("resize", function(){ paint(); });

  send({type:"jh:ready"});
})();
`;
