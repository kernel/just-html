/* ============================================================================
   shared.js — common scaffolding for all anchored-reaction variants.
   Provides: the sample man-page doc, the mock reaction/comment model, W3C
   text-quote anchor resolution, comment-highlight painting, the comment rail
   (variant-b google-docs style: y-aligned cards, no-overlap clamping), the
   selection floating toolbar + curated emoji picker, gravatars, and the
   reaction mutation helpers (add/toggle, grouping).

   Each variant supplies ONLY its own reaction *rendering*. Everything else
   (model shape, anchoring, comment rail) is identical so the variants are a
   fair comparison.
============================================================================ */

const ME = "raf@kernel.sh";
/* curated set per spec */
const EMOJIS = ["👍","👎","🎉","❤️","😄","🚀","👀"];
/* sha256(lowercased email) gravatar hashes */
const GRAV = {
  "raf@kernel.sh":"d90cdba524aef2d5fa01aae4092131a770419bf3f9af02cb37e1f2381cd6704f",
  "hi@raf.xyz":"9f3663fe7dcb7d39251d2f55840b94cd542688be7da210ba04cc35b25cc7c089",
};
const av = (e,s) => `https://gravatar.com/avatar/${GRAV[e]||GRAV[ME]}?d=identicon&s=${s||64}`;

/* ---- the sample document (man-page flavored: paras, code block, list) ---- */
const DOC_HTML = `
  <h1>RECTL(1) — record-control utility</h1>
  <h2>NAME</h2>
  <p>rectl — append-only record store with deterministic compaction.</p>
  <h2>SYNOPSIS</h2>
  <p><code>rectl [--store PATH] &lt;command&gt; [args]</code></p>
  <h2>DESCRIPTION</h2>
  <p>rectl manages an append-only log of records. Writes never mutate existing
  entries; instead every write produces a new immutable segment. Compaction
  runs synchronously inside the write transaction, so a reader never observes a
  half-compacted store. This keeps the failure modes legible: either a write
  landed whole, or it did not land at all.</p>
  <p>The store is durable into the multi-gigabyte range on a single node. We cap
  individual record bodies at two megabytes; anything larger should be stored by
  reference. Each segment retains a full snapshot rather than a diff, which makes
  point-in-time reads cheap at the cost of disk we are happy to spend.</p>
  <h2>COMPACTION</h2>
  <p>Compaction is a three-tier process, smartest first. Tier one maps offsets
  through known edits and is exact. Tier two re-finds records by content when
  offsets are ambiguous. Tier three gives up honestly and marks the record
  orphaned rather than guessing — an acceptable, legible failure mode.</p>
  <pre>$ rectl --store ./data put "hello"
wrote segment 0007 (snapshot, 41 bytes)
$ rectl --store ./data compact
tier1: 3 mapped  tier2: 1 refound  tier3: 1 orphaned</pre>
  <h2>FLAGS</h2>
  <ul>
    <li><code>--store PATH</code> — directory holding segments (required).</li>
    <li><code>--base-version N</code> — refuse the write if the head moved (optimistic concurrency).</li>
    <li><code>--json</code> — emit machine-readable output for agents.</li>
  </ul>
  <h2>NOTES</h2>
  <p>Concurrent writers are serialized with a row lock; transactions are short, so
  queueing is invisible in practice. There is no background sweeper — state is
  derived, never swept. This whole paragraph is deliberately uncommented so you
  have empty text to select and try the toolbar on.</p>`;

/* ---- mock model ----------------------------------------------------------
   Reactions are shaped like the real reactions row PLUS the proposed anchor:
     {id, emoji, author, anchor:{exact,prefix,suffix}|null, comment_id|null}
   anchor!=null  -> ANCHORED reaction (the new thing)
   comment_id!=null -> reaction on a comment (existing)
   both null      -> doc-level reaction (existing)
   Comments use the chosen variant-b shape (subset we need here).
--------------------------------------------------------------------------- */
let REACTIONS = [
  // -- anchored reactions on a "clean" span (no comment): stacking + multi-author
  {id:"rx1", emoji:"🚀", author:"raf@kernel.sh", anchor:{exact:"deterministic compaction", prefix:"record store with ", suffix:"."}, comment_id:null},
  {id:"rx2", emoji:"🚀", author:"hi@raf.xyz",   anchor:{exact:"deterministic compaction", prefix:"record store with ", suffix:"."}, comment_id:null},
  {id:"rx3", emoji:"👍", author:"hi@raf.xyz",   anchor:{exact:"deterministic compaction", prefix:"record store with ", suffix:"."}, comment_id:null},

  // -- single anchored reaction elsewhere
  {id:"rx4", emoji:"👀", author:"hi@raf.xyz",   anchor:{exact:"two megabytes", prefix:"record bodies at ", suffix:"; anything larger"}, comment_id:null},

  // -- THE HARD CASE: a span that ALSO has a comment highlight (see c1) gets reactions
  {id:"rx5", emoji:"❤️", author:"raf@kernel.sh", anchor:{exact:"either a write\n      landed whole, or it did not land at all", prefix:"failure modes legible: ", suffix:"."}, comment_id:null},
  {id:"rx6", emoji:"❤️", author:"hi@raf.xyz",   anchor:{exact:"either a write\n      landed whole, or it did not land at all", prefix:"failure modes legible: ", suffix:"."}, comment_id:null},
  {id:"rx7", emoji:"🎉", author:"raf@kernel.sh", anchor:{exact:"either a write\n      landed whole, or it did not land at all", prefix:"failure modes legible: ", suffix:"."}, comment_id:null},

  // -- reaction on the code block
  {id:"rx8", emoji:"😄", author:"raf@kernel.sh", anchor:{exact:"tier3: 1 orphaned", prefix:"tier2: 1 refound  ", suffix:""}, comment_id:null},

  // -- doc-level reactions (existing behavior, de-emphasized in rail header)
  {id:"rx9",  emoji:"👍", author:"raf@kernel.sh", anchor:null, comment_id:null},
  {id:"rx10", emoji:"👀", author:"hi@raf.xyz",   anchor:null, comment_id:null},

  // -- a comment-level reaction (existing): lives inside comment c1's card
  {id:"rx11", emoji:"👍", author:"hi@raf.xyz",   anchor:null, comment_id:"c1"},
];
let rxSeq = 100;

/* comments — subset of chosen variant-b model. c1 deliberately shares its span
   with the rx5/6/7 reactions (overlap case). */
let COMMENTS = [
  {id:"c1", author:ME, body:"Love this framing — keep it verbatim.",
   anchor:{exact:"either a write\n      landed whole, or it did not land at all", prefix:"failure modes legible: ", suffix:"."}},
  {id:"c2", author:"hi@raf.xyz", body:"Should we name the snapshot retention cap here?",
   anchor:{exact:"full snapshot rather than a diff", prefix:"Each segment retains a ", suffix:", which makes"}},
];

/* ---- DOM handles (populated by renderDoc) ---- */
let doc, stage, cards, rail, docwrap;

function renderDoc(){
  doc = document.getElementById("doc");
  stage = document.getElementById("stage");
  cards = document.getElementById("cards");
  rail = document.getElementById("rail");
  docwrap = document.getElementById("docwrap");
  doc.innerHTML = DOC_HTML;
}

/* ---- W3C text-quote anchor resolution against the live DOM (whitespace-tolerant) ---- */
function findTextRange(anchor){
  const walker=document.createTreeWalker(doc,NodeFilter.SHOW_TEXT,null);
  let nodes=[],full="";
  while(walker.nextNode()){const n=walker.currentNode;nodes.push({node:n,start:full.length});full+=n.nodeValue;}
  const norm=s=>s.replace(/\s+/g," ").trim();
  let idx=full.indexOf(anchor.exact), len=anchor.exact.length;
  if(idx<0){
    const nf=full.replace(/\s+/g," "), ne=norm(anchor.exact), ni=nf.indexOf(ne);
    if(ni<0)return null;
    let raw=0,nrm=0;
    while(nrm<ni){if(/\s/.test(full[raw])){while(/\s/.test(full[raw]))raw++;nrm++;}else{raw++;nrm++;}}
    idx=raw;
    let end=raw,c=0;
    while(c<ne.length&&end<full.length){if(/\s/.test(full[end])){while(/\s/.test(full[end]))end++;c++;}else{end++;c++;}}
    len=end-raw;
  }
  const loc=o=>{for(const e of nodes)if(o>=e.start&&o<=e.start+e.node.nodeValue.length)return{node:e.node,offset:o-e.start};return null;};
  const a=loc(idx),b=loc(idx+len);
  if(!a||!b)return null;
  const r=document.createRange();r.setStart(a.node,a.offset);r.setEnd(b.node,b.offset);return r;
}

function unwrap(el){const p=el.parentNode;while(el.firstChild)p.insertBefore(el.firstChild,el);p.removeChild(el);}

const anchorSig = a => a ? (a.prefix||"")+"|"+a.exact+"|"+(a.suffix||"") : null;

/* ---- comment highlights (solid yellow — the established language) ---- */
function applyComments(){
  COMMENTS.forEach(c=>{
    if(!c.anchor)return;
    const r=findTextRange(c.anchor);if(!r)return;
    try{
      const s=document.createElement("span");
      s.className="hl"; s.dataset.cid=c.id;
      s.appendChild(r.extractContents()); r.insertNode(s); doc.normalize();
    }catch(e){}
  });
}

/* ---- reaction grouping by anchor span ----
   returns [{sig, anchor, byEmoji:{emoji:[authors]}, count}] for anchored reactions */
function groupAnchored(){
  const map=new Map();
  REACTIONS.filter(r=>r.anchor).forEach(r=>{
    const sig=anchorSig(r.anchor);
    if(!map.has(sig))map.set(sig,{sig,anchor:r.anchor,byEmoji:{},count:0});
    const g=map.get(sig);
    (g.byEmoji[r.emoji]=g.byEmoji[r.emoji]||[]).push(r.author);
    g.count++;
  });
  return [...map.values()];
}
function docLevelReactions(){
  const map={};
  REACTIONS.filter(r=>!r.anchor&&!r.comment_id).forEach(r=>{(map[r.emoji]=map[r.emoji]||[]).push(r.author);});
  return map;
}
function commentReactions(cid){
  const map={};
  REACTIONS.filter(r=>r.comment_id===cid).forEach(r=>{(map[r.emoji]=map[r.emoji]||[]).push(r.author);});
  return map;
}

/* ---- mutations (attributed; unique per target+author+emoji; toggle by re-click) ---- */
function toggleReaction(anchor, emoji){
  const sig=anchorSig(anchor);
  const i=REACTIONS.findIndex(r=>anchorSig(r.anchor)===sig && r.emoji===emoji && r.author===ME);
  if(i>=0) REACTIONS.splice(i,1);
  else REACTIONS.push({id:"rx"+(rxSeq++),emoji,author:ME,anchor,comment_id:null});
}
function toggleDocReaction(emoji){
  const i=REACTIONS.findIndex(r=>!r.anchor&&!r.comment_id&&r.emoji===emoji&&r.author===ME);
  if(i>=0)REACTIONS.splice(i,1);
  else REACTIONS.push({id:"rx"+(rxSeq++),emoji,author:ME,anchor:null,comment_id:null});
}
let _pendingAnchor=null;
function addAnchoredReaction(emoji){
  if(!_pendingAnchor)return;
  toggleReaction(_pendingAnchor, emoji); // add (or toggle if re-picked)
  _pendingAnchor=null;
  if(typeof afterAnchoredReactionAdded==="function")afterAnchoredReactionAdded();
}
let afterAnchoredReactionAdded=null;

/* ---- reactor popover (gravatars + emails) — used by several variants ---- */
function showReactorPop(anchorEl, emoji, authors){
  const pop=document.getElementById("pop"); if(!pop)return;
  pop.innerHTML=`<div class="hdr">${emoji} reacted by</div>`+
    authors.map(a=>`<div class="row"><img src="${av(a,36)}">${a}${a===ME?' <span style="color:#3a5b8a">(you)</span>':''}</div>`).join("");
  pop.style.display="block";
  const r=anchorEl.getBoundingClientRect();
  let top=r.bottom+6, left=r.left;
  pop.style.left=Math.min(left, window.innerWidth-250)+"px";
  pop.style.top=top+"px";
}
function hideReactorPop(){const pop=document.getElementById("pop");if(pop)pop.style.display="none";}

/* ---- comment rail (variant-b: y-aligned cards, no-overlap clamping) ---- */
function hlTop(cid){
  const s=doc.querySelector('.hl[data-cid="'+cid+'"]');if(!s)return null;
  const r=s.getBoundingClientRect(),sr=stage.getBoundingClientRect();
  return r.top-sr.top+stage.scrollTop;
}
const esc=s=>(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/\n/g," ");

/* renderRail can be overridden by a variant (e.g. variant B injects rx micro-cards).
   Default: comments only. */
function renderRail(){
  if(!cards)return;
  cards.innerHTML="";
  const cnt=document.getElementById("railCount");
  if(cnt)cnt.textContent=COMMENTS.length+" comment"+(COMMENTS.length!==1?"s":"");
  const withTop=COMMENTS.map(c=>({c,top:hlTop(c.id)})).sort((a,b)=>(a.top??1e9)-(b.top??1e9));
  let lastBottom=0;
  withTop.forEach(({c,top})=>{
    const card=document.createElement("div");
    card.className="card"; card.dataset.cid=c.id;
    const cr=commentReactions(c.id);
    const chips=Object.entries(cr).map(([e,as])=>`<span class="rx-chip" title="${as.join(', ')}"><span class="em">${e}</span><span class="ct">${as.length}</span></span>`).join("");
    card.innerHTML=`<div class="top"><img src="${av(c.author,48)}"><div style="min-width:0">
      <span class="who">${c.author}</span> <span class="when">Jun 11</span>
      <div class="body">${esc(c.body)}</div>
      ${chips?`<div style="display:flex;gap:4px;margin-top:5px">${chips}</div>`:""}
    </div></div>`;
    if(top!==null){const want=Math.max(lastBottom,top);card.style.marginTop=(want-lastBottom)+"px";}
    cards.appendChild(card);
    card.addEventListener("mouseenter",()=>{const h=doc.querySelector('.hl[data-cid="'+c.id+'"]');if(h)h.classList.add("active");card.classList.add("active");});
    card.addEventListener("mouseleave",()=>{const h=doc.querySelector('.hl[data-cid="'+c.id+'"]');if(h)h.classList.remove("active");card.classList.remove("active");});
    lastBottom=card.offsetTop+card.offsetHeight;
  });
}

/* doc-level reaction strip in rail header (de-emphasized) */
function renderDocLevel(){
  const el=document.getElementById("doclevel"); if(!el)return;
  const m=docLevelReactions();
  const entries=Object.entries(m);
  el.innerHTML=`<span class="lbl">on this doc:</span>`+
    entries.map(([e,as])=>`<span class="dchip${as.includes(ME)?' mine':''}" data-emoji="${e}" title="${as.join(', ')}">${e} ${as.length}</span>`).join("")+
    `<span class="dchip" data-add="1" title="react to whole doc" style="color:#bbb">+</span>`;
  el.querySelectorAll(".dchip[data-emoji]").forEach(ch=>{
    ch.addEventListener("click",()=>{toggleDocReaction(ch.dataset.emoji);if(typeof afterAnchoredReactionAdded==="function")afterAnchoredReactionAdded();else renderDocLevel();});
  });
  const add=el.querySelector('[data-add]');
  if(add)add.addEventListener("click",e=>{
    const rect=add.getBoundingClientRect();
    openEmojiPickerAt(rect.left, rect.bottom+4, emoji=>{toggleDocReaction(emoji);if(typeof afterAnchoredReactionAdded==="function")afterAnchoredReactionAdded();else renderDocLevel();});
  });
}

/* ---- selection toolbar + curated emoji picker (reused variant-b pattern) ---- */
let savedAnchor=null, emojiCb=null;
function wireSelectionToolbar(opts){
  const seltool=document.getElementById("seltool"), emojibar=document.getElementById("emojibar");
  EMOJIS.forEach(e=>{const b=document.createElement("button");b.textContent=e;b.dataset.emoji=e;emojibar.appendChild(b);});

  function anchorFromSelection(sel){
    const r=sel.getRangeAt(0);
    const pre=document.createRange();pre.setStart(doc,0);pre.setEnd(r.startContainer,r.startOffset);
    const post=document.createRange();post.setStart(r.endContainer,r.endOffset);post.setEnd(doc,doc.childNodes.length);
    return{exact:sel.toString(),prefix:pre.toString().slice(-32),suffix:post.toString().slice(0,32)};
  }
  document.addEventListener("mouseup",e=>{
    if(e.target.closest(".seltool")||e.target.closest(".emojibar")||e.target.closest(".rail")||e.target.closest(".rx-chip"))return;
    setTimeout(()=>{
      const sel=window.getSelection();
      if(!sel.rangeCount||sel.isCollapsed||!sel.toString().trim()||!doc.contains(sel.anchorNode)){seltool.style.display="none";emojibar.style.display="none";return;}
      const r=sel.getRangeAt(0).getBoundingClientRect();
      savedAnchor=anchorFromSelection(sel);
      const dw=docwrap.getBoundingClientRect();
      seltool.style.display="flex";
      let lx=r.right-dw.left+10;if(lx+40>docwrap.clientWidth)lx=r.left-dw.left-46;
      seltool.style.left=lx+"px";seltool.style.top=(r.top-dw.top)+"px";
    },10);
  });
  seltool.querySelector('[data-act="comment"]').addEventListener("click",()=>{
    seltool.style.display="none";
    alert("(demo) add-comment opens a new rail card — see comments-demo/variant-b. This demo focuses on reactions.");
    window.getSelection().removeAllRanges();
  });
  seltool.querySelector('[data-act="react"]').addEventListener("click",()=>{
    emojibar.style.display="flex";
    emojibar.style.left=seltool.style.left;
    emojibar.style.top=(parseFloat(seltool.style.top)+70)+"px";
    _pendingAnchor=savedAnchor; emojiCb=null;
  });
  emojibar.addEventListener("click",e=>{
    if(!e.target.dataset.emoji)return;
    const emoji=e.target.dataset.emoji;
    emojibar.style.display="none";seltool.style.display="none";
    if(emojiCb){const cb=emojiCb;emojiCb=null;cb(emoji);}
    else if(opts&&opts.onReact){opts.onReact(emoji);}
    window.getSelection().removeAllRanges();
  });
  document.addEventListener("mousedown",e=>{
    if(!e.target.closest(".seltool")&&!e.target.closest(".emojibar")&&!e.target.closest(".rx-chip")){
      // let mouseup handle re-show; hide stale picker only if clicking elsewhere
      if(!window.getSelection().toString().trim()){seltool.style.display="none";emojibar.style.display="none";}
    }
  });
}
/* generic picker opener (doc-level "+", and variants that need it).
   Uses a SEPARATE fixed-position picker so it works anywhere (rail, gutter). */
function openEmojiPickerAt(clientX, clientY, cb){
  let p=document.getElementById("fixedpicker");
  if(!p){
    p=document.createElement("div");p.id="fixedpicker";
    p.style.cssText="position:fixed;display:none;background:#fff;border:1px solid #ccc;border-radius:18px;padding:3px 6px;box-shadow:0 4px 14px rgba(0,0,0,.2);z-index:50;gap:2px";
    EMOJIS.forEach(e=>{const b=document.createElement("button");b.textContent=e;b.dataset.emoji=e;
      b.style.cssText="border:none;background:transparent;font-size:17px;cursor:pointer;padding:2px 4px;border-radius:50%";
      b.onmouseenter=()=>b.style.background="#f0f0f0";b.onmouseleave=()=>b.style.background="transparent";p.appendChild(b);});
    document.body.appendChild(p);
    p.addEventListener("click",e=>{if(!e.target.dataset.emoji)return;p.style.display="none";const cb=p._cb;p._cb=null;if(cb)cb(e.target.dataset.emoji);});
    document.addEventListener("mousedown",e=>{if(!e.target.closest("#fixedpicker")&&!e.target.closest("[data-add]")&&!e.target.closest(".rx-add"))p.style.display="none";});
  }
  p.style.display="flex";
  p.style.left=Math.min(clientX,window.innerWidth-260)+"px";
  p.style.top=clientY+"px";
  p._cb=cb;
}
