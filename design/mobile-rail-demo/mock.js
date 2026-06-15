/*
  mock.js — shared mock data + rail rendering, so every variant shares one
  source of truth and differs ONLY in responsive layout.

  THREADS mirror the production Thread shape (CommentsShell.tsx ~61):
  id, author, body, anchor.exact, resolved, replies[], reactions[].
  Each anchored thread's id matches a .jh-hl[data-id] in doc.html, so a tap on
  the highlight (jh:focus) can be mapped to its card.
*/
window.JH = (function () {
  var THREADS = [
    {
      id: 1, author: "lena@kernel.sh", avatar: "https://gravatar.com/avatar/0?d=identicon&s=36",
      body: "Is the timestamp preserved across a rebase too, or only within a session?",
      anchor: "preserves the original staging timestamps", resolved: false,
      reactions: [{ emoji: "👀", count: 1 }],
      replies: [{ author: "marco@kernel.sh", body: "Within the session only — rebase resets it." }],
    },
    {
      id: 2, author: "marco@kernel.sh", avatar: "https://gravatar.com/avatar/1?d=identicon&s=36",
      body: "We should warn when --all restages generated files. Footgun.",
      anchor: "restage every tracked file with modifications", resolved: false,
      reactions: [], replies: [],
    },
    {
      id: 3, author: "lena@kernel.sh", avatar: "https://gravatar.com/avatar/2?d=identicon&s=36",
      body: "exit 128 matches git-add's detached-HEAD behavior — good consistency.",
      anchor: "not supported in detached HEAD state", resolved: true,
      reactions: [], replies: [],
    },
  ];
  var DOC_REACTIONS = [{ emoji: "🎉", count: 3 }];

  function fmt() { return "Jun 12, 2:14 PM"; }

  // Render the rail's inner content into a given container. `opts.onFocus(id)`
  // wired so the variant can react to a card tap (scroll the iframe highlight).
  function renderRail(container, opts) {
    opts = opts || {};
    var showResolved = opts.showResolved || false;
    var visible = THREADS.filter(function (t) { return showResolved || !t.resolved; });
    var html = "";
    html += '<div class="jh-railhead">';
    html += '<span>' + visible.length + ' comment' + (visible.length !== 1 ? 's' : '') + '</span>';
    html += '<span style="display:flex;gap:10px;align-items:center">';
    html += '<span class="jh-resolvetoggle">' + (showResolved ? 'hide resolved' : 'show resolved') + '</span>';
    if (opts.closeable) html += '<button class="jh-railclose" title="close">✕</button>';
    html += '</span></div>';
    html += '<div class="jh-docreactions"><span>on this doc:</span>';
    DOC_REACTIONS.forEach(function (r) { html += '<span class="jh-chip" style="margin-top:0">' + r.emoji + ' ' + r.count + '</span>'; });
    html += '</div>';
    html += '<div class="jh-cards">';
    visible.forEach(function (t) {
      html += '<div class="jh-card" data-id="' + t.id + '"' + (t.resolved ? ' data-orphan="0"' : '') + '>';
      html += '<div class="row">';
      html += '<img class="avatar" src="' + t.avatar + '" alt="" />';
      html += '<div style="min-width:0">';
      html += '<span class="who">' + t.author + '</span> <span class="when">' + fmt() + '</span> ';
      if (t.resolved) html += '<span class="badge res">resolved</span>';
      html += '<div class="body">' + t.body + '</div>';
      t.reactions.forEach(function (r) { html += '<span class="jh-chip">' + r.emoji + ' ' + r.count + '</span>'; });
      html += '</div></div>';
      if (t.replies.length) html += '<div class="hint">' + t.replies.length + ' repl' + (t.replies.length > 1 ? 'ies' : 'y') + ' ▾ · click to reply…</div>';
      else html += '<div class="hint">click to reply…</div>';
      html += '</div>';
    });
    html += '</div>';
    container.innerHTML = html;

    // wire interactions
    var resolveToggle = container.querySelector('.jh-resolvetoggle');
    if (resolveToggle) resolveToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      renderRail(container, Object.assign({}, opts, { showResolved: !showResolved }));
    });
    var closeBtn = container.querySelector('.jh-railclose');
    if (closeBtn && opts.onClose) closeBtn.addEventListener('click', function (e) { e.stopPropagation(); opts.onClose(); });
    container.querySelectorAll('.jh-card').forEach(function (card) {
      card.addEventListener('click', function () {
        container.querySelectorAll('.jh-card').forEach(function (c) { c.removeAttribute('data-focused'); });
        card.setAttribute('data-focused', '1');
        if (opts.onFocus) opts.onFocus(parseInt(card.getAttribute('data-id'), 10));
      });
    });
  }

  function focusCard(container, id) {
    container.querySelectorAll('.jh-card').forEach(function (c) { c.removeAttribute('data-focused'); });
    var card = container.querySelector('.jh-card[data-id="' + id + '"]');
    if (card) {
      card.setAttribute('data-focused', '1');
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    return card;
  }

  return {
    THREADS: THREADS,
    count: THREADS.filter(function (t) { return !t.resolved; }).length,
    total: THREADS.length,
    renderRail: renderRail,
    focusCard: focusCard,
  };
})();
