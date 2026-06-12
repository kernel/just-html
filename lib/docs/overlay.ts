// Overlay script injected into the SANDBOXED iframe (/d/:slug/raw?overlay=1),
// and ONLY when the shell embeds it (the shell appends overlay=1; direct /raw
// fetches stay byte-pristine — birthday.md "Production architecture").
//
// The user HTML stays origin-less in the sandbox. This script runs INSIDE that
// sandbox and talks to the shell (the React rail) only via postMessage:
//
//   shell → overlay:  { type:"jh:anchors", anchors:[{id, exact, prefix, suffix, resolved}] }
//                     { type:"jh:reactions", me, groups:[{sig, exact, prefix, suffix,
//                          reactions:[{emoji,count,mine,authors}]}] }
//                     { type:"jh:active", id }            (hover/pin highlight)
//                     { type:"jh:scrollTo", id }
//                     { type:"jh:clearSelection" }
//   overlay → shell:  { type:"jh:ready" }
//                     { type:"jh:positions", positions:{ [id]: yTopPx } }  (highlight y in doc coords)
//                     { type:"jh:selection", anchor:{exact,prefix,suffix}, rect:{...} }
//                     { type:"jh:selectionCleared" }
//                     { type:"jh:hlClick", id } / { type:"jh:hlHover", id }
//                     { type:"jh:reactionToggle", anchor:{exact,prefix,suffix}, emoji } (chip click)
//
// B13 (birthday.md "Anchored reactions", variant A revised): a reacted span
// paints the SAME yellow highlight as a comment anchor (NOT the demo's dotted
// underline) — the comment-vs-reaction distinction is the attachment (rail card
// vs. inline emoji chip), not the paint. The chip (emoji + count) is rendered
// INLINE at the END of the reacted span, in the document's text flow. Chip hover
// → reactor gravatars/emails popover; clicking your own toggles it off. The shell
// drives an optimistic local update (it re-sends jh:reactions immediately), so
// the chip + highlight appear with no reload.
//
// The overlay resolves W3C text-quotes against the live DOM (prefix/suffix
// disambiguation). It never reads cookies (sandbox = opaque origin) and only
// accepts messages from the parent window.

export const OVERLAY_SCRIPT = String.raw`
(function(){
  "use strict";
  if (window.__jhOverlay) return; window.__jhOverlay = true;

  var anchors = [];          // [{id, exact, prefix, suffix, resolved}]  (comments)
  var rxGroups = [];         // [{sig, exact, prefix, suffix, reactions:[{emoji,count,mine,authors}]}]
  var me = null;             // viewer email (for "(you)" in the popover)
  var ranges = {};           // comment id -> highlight span
  var rxRanges = {};         // reaction sig -> highlight span
  var activeId = null;

  function send(msg){ try { parent.postMessage(msg, "*"); } catch(e){} }
  function esc(s){ return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  // ---- text-content walker (anchor resolution against the live DOM) ----
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
  function squash(s){ return (s||"").replace(/\s+/g," "); }

  function findRange(tx, a){
    var full = tx.full, nodes = tx.nodes;
    var occ = [], from = 0, idx;
    while ((idx = full.indexOf(a.exact, from)) !== -1){ occ.push(idx); from = idx + 1; if (occ.length>5000) break; }
    if (occ.length === 0){
      var nf = squash(full), ne = squash(a.exact), ni = nf.indexOf(ne);
      if (ni < 0) return null;
      var raw = 0, nrm = 0;
      while (nrm < ni && raw < full.length){ if (/\s/.test(full[raw])){ while(/\s/.test(full[raw])) raw++; nrm++; } else { raw++; nrm++; } }
      var end = raw, c = 0, neLen = ne.length;
      while (c < neLen && end < full.length){ if (/\s/.test(full[end])){ while(/\s/.test(full[end])) end++; c++; } else { end++; c++; } }
      var aLen = end - raw;
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
      if (tie && best<=0) return null;
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
    document.querySelectorAll("[data-jh-chip]").forEach(function(n){ n.remove(); });
    if (document.body) document.body.normalize();
    ranges = {};
    rxRanges = {};
  }

  function ensureStyle(){
    if (document.getElementById("jh-overlay-style")) return;
    var st = document.createElement("style"); st.id = "jh-overlay-style";
    // Comments AND reactions paint the SAME yellow highlight (founder: identical
    // paint; the demo's dotted underline is overridden). Distinction is the
    // attachment, not the paint. Depth shading on a span covered by both is left
    // to B14 overlap; here a doubly-covered span just stays highlighted once.
    st.textContent =
      "span[data-jh-hl]{background:#fff3bf;border-bottom:1px solid #f1d96b;cursor:pointer;transition:background .12s}"
      + "span[data-jh-hl].jh-active{background:#ffe089}"
      + "span[data-jh-chip]{display:inline-flex;align-items:center;gap:2px;font-size:11.5px;line-height:1;"
      + "background:#fbfbfb;border:1px solid #e0e0e0;border-radius:10px;padding:1px 6px 1px 5px;margin-left:4px;"
      + "vertical-align:.12em;font-family:ui-monospace,Menlo,Consolas,monospace;cursor:pointer;user-select:none;"
      + "white-space:nowrap;transition:border-color .1s,background .1s}"
      + "span[data-jh-chip]:hover{border-color:#bbb;background:#fff}"
      + "span[data-jh-chip].mine{border-color:#9db8d8;background:#eef3fb}"
      + "span[data-jh-chip] .jh-em{font-size:13px}"
      + "span[data-jh-chip] .jh-ct{color:#666}"
      + "span[data-jh-chip].mine .jh-ct{color:#3a5b8a}"
      + "#jh-rx-pop{position:fixed;display:none;background:#fff;border:1px solid #ccc;border-radius:6px;"
      + "box-shadow:0 4px 16px rgba(0,0,0,.18);z-index:2147483647;padding:6px 8px;font-size:11px;max-width:260px;"
      + "font-family:ui-monospace,Menlo,Consolas,monospace;color:#222}"
      + "#jh-rx-pop .jh-row{display:flex;align-items:center;gap:6px;padding:2px 0}"
      + "#jh-rx-pop img{width:18px;height:18px;border-radius:50%}"
      + "#jh-rx-pop .jh-hdr{color:#888;font-size:10px;margin-bottom:3px}";
    (document.head||document.documentElement).appendChild(st);
  }

  function paint(){
    ensureStyle();
    clearHighlights();
    var tx = buildText();

    // 1) comment highlights
    anchors.forEach(function(a){
      if (!a.exact) return;
      var r = findRange(tx, a);
      if (!r) return;
      try {
        var span = document.createElement("span");
        span.setAttribute("data-jh-hl", a.id);
        span.appendChild(r.extractContents());
        r.insertNode(span);
        document.body.normalize();
        ranges[a.id] = span;
        span.addEventListener("click", function(ev){ ev.stopPropagation(); send({type:"jh:hlClick", id:a.id}); });
        span.addEventListener("mouseenter", function(){ send({type:"jh:hlHover", id:a.id}); });
      } catch(e){}
      tx = buildText();
    });

    // 2) reaction highlights + inline chips (same yellow paint, chip at span end)
    rxGroups.forEach(function(g){
      if (!g.exact) return;
      var r = findRange(tx, g);
      if (!r) return;
      try {
        var span = document.createElement("span");
        span.setAttribute("data-jh-hl", "rx:"+g.sig);
        span.setAttribute("data-jh-rx", "1");
        span.appendChild(r.extractContents());
        r.insertNode(span);
        document.body.normalize();
        rxRanges[g.sig] = span;
        // chips immediately AFTER the span, inline in the text flow
        var frag = document.createDocumentFragment();
        (g.reactions||[]).forEach(function(rx){
          var chip = document.createElement("span");
          chip.setAttribute("data-jh-chip","1");
          if (rx.mine) chip.className = "mine";
          chip.innerHTML = '<span class="jh-em">'+esc(rx.emoji)+'</span><span class="jh-ct">'+rx.count+'</span>';
          chip.title = (rx.authors||[]).join(", ");
          chip.addEventListener("click", function(ev){
            ev.stopPropagation();
            send({type:"jh:reactionToggle", anchor:{exact:g.exact, prefix:g.prefix, suffix:g.suffix}, emoji:rx.emoji});
          });
          chip.addEventListener("mouseenter", function(ev){ showRxPop(ev.currentTarget, rx.emoji, rx.authors||[]); });
          chip.addEventListener("mouseleave", hideRxPop);
          frag.appendChild(chip);
        });
        span.after(frag);
        document.body.normalize();
      } catch(e){}
      tx = buildText();
    });

    reportPositions();
  }

  // ---- reactor popover (gravatars + emails) ----
  function rxPopEl(){
    var p = document.getElementById("jh-rx-pop");
    if (!p){ p = document.createElement("div"); p.id = "jh-rx-pop"; (document.body||document.documentElement).appendChild(p); }
    return p;
  }
  function av(email){
    // The shell sends a { email -> gravatarUrl } map (it can sha256 the email);
    // the sandbox just looks it up. Missing → render the email alone.
    if (window.__jhAvatars && window.__jhAvatars[email]) return window.__jhAvatars[email];
    return null;
  }
  function showRxPop(chipEl, emoji, authors){
    var p = rxPopEl();
    p.innerHTML = '<div class="jh-hdr">'+esc(emoji)+' reacted by</div>' +
      authors.map(function(a){
        var url = av(a);
        var img = url ? '<img src="'+esc(url)+'" alt="">' : '';
        var you = (me && a===me) ? ' <span style="color:#3a5b8a">(you)</span>' : '';
        return '<div class="jh-row">'+img+esc(a)+you+'</div>';
      }).join("");
    p.style.display = "block";
    var r = chipEl.getBoundingClientRect();
    p.style.left = Math.min(r.left, window.innerWidth - 270) + "px";
    p.style.top = (r.bottom + 6) + "px";
  }
  function hideRxPop(){ var p = document.getElementById("jh-rx-pop"); if (p) p.style.display = "none"; }

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
  document.addEventListener("mouseup", function(ev){
    if (ev.target && ev.target.closest && ev.target.closest("[data-jh-chip]")) return;
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
    else if (d.type === "jh:reactions"){
      rxGroups = Array.isArray(d.groups) ? d.groups : [];
      me = d.me || me;
      if (d.avatars) window.__jhAvatars = d.avatars;
      paint();
    }
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
