"use client";

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";

// CommentsShell — the THIRD React surface (birthday.md "Production
// architecture", "CHOSEN: variant B"). The google-docs-style comment rail. The
// user HTML stays in the origin-less sandboxed iframe (left); this rail lives in
// the shell (right) and talks to the injected overlay (raw?overlay=1) via
// postMessage:
//
//   shell → overlay: jh:anchors (resolve+paint), jh:reactions (chips+paint),
//                    jh:active (hover sync), jh:focus (pin/focus a key),
//                    jh:scrollTo, jh:clearSelection, jh:ping
//   overlay → shell: jh:ready, jh:positions (highlight y → card alignment),
//                    jh:selection / jh:selectionCleared (selection toolbar),
//                    jh:focus (segment clicked: focused key + covering set),
//                    jh:hlHover / jh:hlHoverOut (highlight ↔ card sync),
//                    jh:reactionToggle (chip click)
//
// B14 "Overlap semantics": the overlay paints SEGMENTS (split at every anchor
// boundary, comments + reactions unified) with depth shading; focus cycles the
// covering set. The shell only needs to map comment ids ↔ rail cards; reaction
// focus has no card (chips are inline). See lib/docs/overlay.ts.
//
// Reproduces the variant-b.html interaction feel: rail cards aligned to their
// highlight's vertical position with no-overlap clamping; cards expand in place
// to reply; show-resolved toggle; dashed orphan cards; Gravatar avatars;
// vertical selection toolbar (add comment + react). All persistence goes through
// /api/v1/docs/:slug/comments and /reactions; the API enforces permissions.

const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace`;
// The picker set — the curated brand emoji (birthday.md B11 example set). Every
// one is in the server's ALLOWED_EMOJI (lib/docs/reactions.ts); agents may also
// react with the wider allowed set, but the human picker stays small.
const EMOJIS = ["👍", "👎", "🎉", "❤️", "😄", "🚀", "👀"];

type Reaction = { emoji: string; count: number; authors: string[] };
type Anchor = { exact: string; prefix?: string; suffix?: string; start?: number; end?: number } | null;
// Anchored reaction group (one per span), as returned by GET /comments grouped by
// anchor signature (birthday.md "Anchored reactions": clients stack/count without
// re-grouping). The chip is painted inline at the END of the span by the overlay.
type AnchoredReactionGroup = {
  sig: string;
  anchor: NonNullable<Anchor>;
  anchored_version: number | null;
  reactions: Reaction[];
};
type Comment = {
  id: number;
  parent_id: number | null;
  author: string | null;
  author_avatar: string | null;
  body: string;
  anchor: Anchor;
  orphaned: boolean;
  resolved: boolean;
  created_at: string;
  edited_at: string | null;
  reactions: Reaction[];
};
type Thread = Comment & { group: "anchored" | "doc" | "orphaned"; replies: Comment[] };

type Props = {
  slug: string;
  title: string;
  rawSrc: string;
  viewtoken: string | null;
  canComment: boolean;
  canReact: boolean;
  signedIn: boolean;
  me: string | null;
  initialThreads: Thread[];
  initialDocReactions: Reaction[];
  initialAnchoredReactions: AnchoredReactionGroup[];
  version: number;
};

/**
 * Anchor signature for OPTIMISTIC local grouping only. We prefer the server-sent
 * `sig` (every AnchoredReactionGroup from GET /comments carries one); this is the
 * sole case where no server sig exists yet — a brand-new span reaction the user
 * just clicked, before the server round-trip. It MUST stay byte-identical to the
 * canonical anchorSignature() in lib/docs/anchor.ts (the source of truth, also
 * the DB index + overlay key); cannot import it (server code).
 */
function anchorSig(a: NonNullable<Anchor>): string {
  return `${a.prefix ?? ""}|${a.exact}|${a.suffix ?? ""}`;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default function CommentsShell(props: Props) {
  const { slug, title, rawSrc, viewtoken, canComment, canReact, signedIn, me } = props;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [threads, setThreads] = useState<Thread[]>(props.initialThreads);
  const [docReactions, setDocReactions] = useState<Reaction[]>(props.initialDocReactions);
  const [anchoredReactions, setAnchoredReactions] = useState<AnchoredReactionGroup[]>(
    props.initialAnchoredReactions
  );
  // email -> gravatar URL (async-computed; sent to the overlay for the chip popover)
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  // Latest reactAnchored, refd so the message-listener effect (declared earlier)
  // can call it without depending on its declaration order or re-subscribing.
  const reactAnchoredRef = useRef<(emoji: string, anchor: NonNullable<Anchor>) => void>(() => {});
  const [showResolved, setShowResolved] = useState(false);
  const [pinnedId, setPinnedId] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [positions, setPositions] = useState<Record<number, number>>({});
  const [overlayReady, setOverlayReady] = useState(false);

  // Selection state (from the overlay) → the floating toolbar + a pending draft.
  const [selection, setSelection] = useState<{ anchor: NonNullable<Anchor>; top: number; viewTop: number } | null>(null);
  const [draft, setDraft] = useState<{ anchor: NonNullable<Anchor>; top: number } | null>(null);

  const apiBase = `/api/v1/docs/${encodeURIComponent(slug)}`;
  const tokenQuery = viewtoken ? `?viewtoken=${encodeURIComponent(viewtoken)}` : "";

  // The anchors we ask the overlay to paint (anchored, non-orphaned roots that
  // are visible under the resolved toggle).
  const paintAnchors = useMemo(
    () =>
      threads
        .filter((t) => t.group === "anchored" && t.anchor && (showResolved || !t.resolved))
        .map((t) => ({ id: t.id, exact: t.anchor!.exact, prefix: t.anchor!.prefix, suffix: t.anchor!.suffix })),
    [threads, showResolved]
  );

  // Reaction groups to paint inline (each span's chip set), with a `mine` flag so
  // the overlay can style "my" chip + know what a re-click toggles off.
  const paintReactionGroups = useMemo(
    () =>
      anchoredReactions.map((g) => ({
        sig: g.sig,
        exact: g.anchor.exact,
        prefix: g.anchor.prefix,
        suffix: g.anchor.suffix,
        reactions: g.reactions.map((r) => ({
          emoji: r.emoji,
          count: r.count,
          authors: r.authors,
          mine: me != null && r.authors.includes(me),
        })),
      })),
    [anchoredReactions, me]
  );

  const postToOverlay = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  // Compute gravatar URLs (sha256 of the lowercased email) for every reactor +
  // commenter, so the overlay's chip popover can show avatars. Async (SubtleCrypto)
  // but cheap; the result is cached in state and re-sent with jh:reactions.
  useEffect(() => {
    const emails = new Set<string>();
    for (const g of anchoredReactions) for (const r of g.reactions) for (const e of r.authors) emails.add(e);
    for (const r of docReactions) for (const e of r.authors) emails.add(e);
    const missing = [...emails].filter((e) => !(e in avatars));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const email of missing) {
        try {
          const data = new TextEncoder().encode(email.trim().toLowerCase());
          const buf = await crypto.subtle.digest("SHA-256", data);
          const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
          next[email] = `https://gravatar.com/avatar/${hex}?d=identicon&s=36`;
        } catch {
          /* SubtleCrypto unavailable (non-secure context) — skip avatars. */
        }
      }
      if (!cancelled && Object.keys(next).length) setAvatars((a) => ({ ...a, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [anchoredReactions, docReactions, avatars]);

  // Send anchors whenever they change or the overlay (re)becomes ready.
  useEffect(() => {
    if (overlayReady) postToOverlay({ type: "jh:anchors", anchors: paintAnchors });
  }, [overlayReady, paintAnchors, postToOverlay]);

  // Send anchored reactions (inline chips) likewise. Re-sent on every change,
  // which is the optimistic-update path: the local state mutates → this fires →
  // the overlay repaints the chip/highlight with no reload (birthday.md HARD
  // REQUIREMENT).
  useEffect(() => {
    if (overlayReady)
      postToOverlay({ type: "jh:reactions", groups: paintReactionGroups, me, avatars });
  }, [overlayReady, paintReactionGroups, me, avatars, postToOverlay]);

  // Listen to overlay messages. Only accept messages from our iframe's window
  // (the sandboxed iframe posts with origin "null"; we match on source window).
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const d = ev.data;
      if (!d || typeof d !== "object") return;
      switch (d.type) {
        case "jh:ready":
          setOverlayReady(true);
          postToOverlay({ type: "jh:anchors", anchors: paintAnchors });
          postToOverlay({ type: "jh:reactions", groups: paintReactionGroups, me, avatars });
          break;
        case "jh:positions":
          setPositions(d.positions || {});
          break;
        case "jh:selection":
          if ((canComment || canReact) && d.anchor && d.anchor.exact) {
            setSelection({ anchor: d.anchor, top: d.rect?.top ?? 0, viewTop: d.rect?.viewTop ?? 0 });
          }
          break;
        case "jh:selectionCleared":
          setSelection(null);
          break;
        case "jh:focus":
          // B14 focus model (doc → rail): a segment was clicked/cycled in the doc.
          // d.id is a comment id (number), a reaction key ("r:<sig>"), or null
          // (focus cleared). Pin + scroll the matching rail card for comments;
          // reaction-only focus has no rail card (chips live inline) so we just
          // clear any pinned comment. The overlay already painted the focus/dim.
          if (d.id == null) {
            setPinnedId(null);
            setActiveId(null);
          } else if (typeof d.id === "number") {
            setPinnedId(d.id);
            setActiveId(d.id);
          } else {
            // reaction key focused — no rail card to pin
            setPinnedId(null);
            setActiveId(null);
          }
          break;
        case "jh:hlHover":
          // d.id: comment id (number) or "r:<sig>" — only comment cards exist in
          // the rail, so only numeric ids drive the rail's active state.
          setActiveId(typeof d.id === "number" ? d.id : null);
          break;
        case "jh:hlHoverOut":
          setActiveId(null);
          break;
        case "jh:reactionToggle":
          // A chip was clicked inside the iframe → optimistic toggle (add/remove).
          if (canReact && d.anchor && d.anchor.exact) reactAnchoredRef.current(d.emoji, d.anchor);
          break;
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [paintAnchors, paintReactionGroups, me, avatars, postToOverlay, canComment, canReact]);

  const reload = useCallback(async () => {
    const r = await fetch(`${apiBase}/comments${tokenQuery}`, { credentials: "same-origin" });
    if (r.ok) {
      const j = await r.json();
      setThreads(j.threads || []);
      setDocReactions(j.doc_reactions || []);
      setAnchoredReactions(j.anchored_reactions || []);
    }
  }, [apiBase, tokenQuery]);

  // --- API actions ---
  const postComment = useCallback(
    async (body: string, anchor: NonNullable<Anchor> | null, parentId: number | null) => {
      const r = await fetch(`${apiBase}/comments${tokenQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ body, anchor: anchor ?? undefined, parent_id: parentId ?? undefined }),
      });
      if (r.ok) await reload();
      return r.ok;
    },
    [apiBase, tokenQuery, reload]
  );

  const toggleResolve = useCallback(
    async (id: number, resolved: boolean) => {
      const r = await fetch(`${apiBase}/comments/${id}${tokenQuery}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ resolved }),
      });
      if (r.ok) await reload();
    },
    [apiBase, tokenQuery, reload]
  );

  const deleteComment = useCallback(
    async (id: number) => {
      const r = await fetch(`${apiBase}/comments/${id}${tokenQuery}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (r.ok) await reload();
    },
    [apiBase, tokenQuery, reload]
  );

  const react = useCallback(
    async (emoji: string, commentId: number | null) => {
      const r = await fetch(`${apiBase}/reactions${tokenQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ emoji, comment_id: commentId ?? undefined }),
      });
      if (r.ok) await reload();
    },
    [apiBase, tokenQuery, reload]
  );

  // Anchored reaction (on a SPAN). OPTIMISTIC (birthday.md HARD REQUIREMENT): the
  // local state mutates first so the chip + highlight paint immediately via the
  // jh:reactions postMessage — no reload, no refetch wait. The POST runs in the
  // background; on completion we reconcile with the server's truth, on failure we
  // roll back. Same path for add and toggle-off (re-clicking your own emoji).
  const reactAnchored = useCallback(
    (emoji: string, anchor: NonNullable<Anchor>) => {
      if (!me) {
        // No identity → can't attribute/toggle; just POST (will 401) and reload.
        void (async () => {
          await fetch(`${apiBase}/reactions${tokenQuery}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ emoji, anchor }),
          });
          await reload();
        })();
        return;
      }
      const sig = anchorSig(anchor);
      // Optimistic local mutation: add my reaction, or remove it if I already
      // reacted with this emoji on this span (toggle off). Empty groups are dropped.
      setAnchoredReactions((prev) => {
        const next = prev.map((g) => ({ ...g, reactions: g.reactions.map((r) => ({ ...r })) }));
        let g = next.find((x) => x.sig === sig);
        if (!g) {
          g = { sig, anchor, anchored_version: null, reactions: [] };
          next.push(g);
        }
        const ex = g.reactions.find((r) => r.emoji === emoji);
        const iReacted = ex ? ex.authors.includes(me) : false;
        if (iReacted && ex) {
          ex.authors = ex.authors.filter((a) => a !== me);
          ex.count = ex.authors.length;
        } else if (ex) {
          ex.authors = [...ex.authors, me];
          ex.count = ex.authors.length;
        } else {
          g.reactions.push({ emoji, count: 1, authors: [me] });
        }
        // prune empty emoji + empty spans (chip/highlight removed at count 0)
        g.reactions = g.reactions.filter((r) => r.count > 0);
        return next.filter((x) => x.reactions.length > 0);
      });
      // Fire-and-reconcile.
      void (async () => {
        const r = await fetch(`${apiBase}/reactions${tokenQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ emoji, anchor }),
        });
        // Reconcile with server truth (covers re-anchor offset updates, races,
        // and the failure path — reload reflects the canonical state either way).
        await reload();
        if (!r.ok) {
          // best-effort: reload already corrected the optimistic state.
        }
      })();
    },
    [apiBase, tokenQuery, reload, me]
  );
  reactAnchoredRef.current = reactAnchored;

  // Sync the active highlight to the overlay.
  useEffect(() => {
    if (overlayReady) postToOverlay({ type: "jh:active", id: activeId });
  }, [activeId, overlayReady, postToOverlay]);

  const visibleThreads = useMemo(
    () => threads.filter((t) => showResolved || !t.resolved),
    [threads, showResolved]
  );

  // Card vertical layout: anchored cards align to their highlight y (from the
  // overlay's reported positions) with no-overlap clamping; doc-level + orphaned
  // stack after. Reproduces variant-b.html's docs-style alignment.
  const railRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div style={barStyle}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700 }}>
          {title}
        </span>
        <span style={{ flexShrink: 0, paddingLeft: "1.25rem", display: "flex", gap: "1.25rem", alignItems: "center", color: "#666" }}>
          <a href={`/d/${encodeURIComponent(slug)}/history${tokenQuery}`} style={{ color: "#666" }}>history</a>
          <span>made with <a href="/" style={{ color: "#666" }}>justhtml.sh</a></span>
        </span>
      </div>

      <div ref={stageRef} style={stageStyle}>
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <iframe
            ref={iframeRef}
            title={title}
            src={rawSrc}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            style={{ border: "none", width: "100%", height: "100%", display: "block", background: "#fff" }}
          />
          {/* selection toolbar — overlaid on the docwrap; positioned to the
              selection's viewport-top within the iframe. Shows on selection when
              the viewer can comment OR react (react-only viewers still get the
              react affordance). */}
          {selection && (canComment || canReact) ? (
            <SelectionToolbar
              viewTop={selection.viewTop}
              canComment={canComment}
              canReact={canReact}
              onComment={() => {
                setDraft({ anchor: selection.anchor, top: selection.top });
                setSelection(null);
                postToOverlay({ type: "jh:clearSelection" });
              }}
              onReact={(emoji) => {
                // B13: the selection toolbar's react flow creates an ANCHORED
                // reaction (anchor = the selection quote), not a doc-level one.
                // Optimistic: the chip + highlight appear immediately (no reload).
                reactAnchored(emoji, selection.anchor);
                setSelection(null);
                postToOverlay({ type: "jh:clearSelection" });
              }}
            />
          ) : null}
        </div>

        <aside style={railStyle} ref={railRef}>
          <div style={railHeadStyle}>
            <span>
              {visibleThreads.length} comment{visibleThreads.length !== 1 ? "s" : ""}
            </span>
            <span style={{ cursor: "pointer", color: "#888" }} onClick={() => setShowResolved((s) => !s)}>
              {showResolved ? "hide resolved" : "show resolved"}
            </span>
          </div>

          {/* Doc-level reactions, compact in the rail header (birthday.md B11:
              "doc-level reactions render compactly in the rail header"). The
              react chip set + a mini picker for anyone who can react. */}
          {docReactions.length > 0 || canReact ? (
            <div style={docReactionsRowStyle}>
              <span style={{ color: "#999", fontSize: 10.5, marginRight: 2 }}>on this doc:</span>
              <Reactions
                reactions={docReactions}
                canComment={canReact}
                onReact={(e) => react(e, null)}
              />
            </div>
          ) : null}

          {!signedIn ? (
            <div style={{ padding: "8px 10px", fontSize: 12, color: "#666", borderBottom: "1px solid #eee" }}>
              <a href={`/login?next=${encodeURIComponent(`/d/${slug}`)}`} target="_blank" rel="noopener">Sign in</a> to comment.
            </div>
          ) : null}

          <RailCards
            threads={visibleThreads}
            positions={positions}
            pinnedId={pinnedId}
            activeId={activeId}
            canComment={canComment}
            draft={draft}
            onPin={(id) => {
              setPinnedId(id);
              setActiveId(id);
              // B14 rail → doc: focusing a card focuses its anchor in the document
              // (intensify + dim others + scroll into view). Unpin clears focus.
              if (id != null) postToOverlay({ type: "jh:focus", key: `c:${id}` });
              else postToOverlay({ type: "jh:focus", key: null });
            }}
            onHover={(id) => setActiveId(id)}
            onReply={postComment}
            onResolve={toggleResolve}
            onDelete={deleteComment}
            onReact={react}
            onSubmitDraft={async (body) => {
              if (!draft) return;
              const ok = await postComment(body, draft.anchor, null);
              if (ok) setDraft(null);
            }}
            onCancelDraft={() => setDraft(null)}
          />
        </aside>
      </div>
    </>
  );
}

// --------------------------- subcomponents ---------------------------

function SelectionToolbar({
  viewTop,
  canComment,
  canReact,
  onComment,
  onReact,
}: {
  viewTop: number;
  canComment: boolean;
  canReact: boolean;
  onComment: () => void;
  onReact: (emoji: string) => void;
}) {
  // The iframe spans the docwrap; the selection rect's viewport-top maps onto the
  // docwrap (both share the top edge). Clamp into view.
  const top = Math.max(8, viewTop);
  const [picking, setPicking] = useState(false);
  return (
    <div style={{ ...seltoolStyle, top }}>
      {canComment ? (
        <button title="add comment" style={seltoolBtn} onClick={onComment}>
          💬
        </button>
      ) : null}
      {canReact ? (
        <button title="add reaction" style={seltoolBtn} onClick={() => setPicking((p) => !p)}>
          😊
        </button>
      ) : null}
      {/* B11 mini picker — the curated set, opens beside the react button. */}
      {picking && canReact ? (
        <div style={seltoolPickerStyle}>
          {EMOJIS.map((e) => (
            <span
              key={e}
              style={{ cursor: "pointer", fontSize: 16, padding: "1px 2px" }}
              onClick={() => {
                onReact(e);
                setPicking(false);
              }}
            >
              {e}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RailCards(props: {
  threads: Thread[];
  positions: Record<number, number>;
  pinnedId: number | null;
  activeId: number | null;
  canComment: boolean;
  draft: { anchor: NonNullable<Anchor>; top: number } | null;
  onPin: (id: number | null) => void;
  onHover: (id: number | null) => void;
  onReply: (body: string, anchor: null, parentId: number) => Promise<boolean>;
  onResolve: (id: number, resolved: boolean) => void;
  onDelete: (id: number) => void;
  onReact: (emoji: string, commentId: number | null) => void;
  onSubmitDraft: (body: string) => void;
  onCancelDraft: () => void;
}) {
  const {
    threads,
    positions,
    pinnedId,
    activeId,
    canComment,
    draft,
    onPin,
    onHover,
    onReply,
    onResolve,
    onDelete,
    onReact,
    onSubmitDraft,
    onCancelDraft,
  } = props;

  // Compute no-overlap clamped offsets for anchored cards. We don't know exact
  // card heights pre-render, so we apply marginTop = max(0, want - lastBottom)
  // using an estimated min gap; the browser then lays them out. We measure with
  // refs after paint to refine clamping.
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [, force] = useState(0);

  useEffect(() => {
    // Re-clamp after layout: walk cards in DOM order, push each down so its top
    // is >= previous card's bottom + gap, and >= its anchor y.
    const anchored = threads.filter((t) => t.group === "anchored");
    let lastBottom = 0;
    let changed = false;
    for (const t of anchored) {
      const el = cardRefs.current.get(t.id);
      if (!el) continue;
      const want = Math.max(lastBottom, positions[t.id] ?? lastBottom);
      const curMargin = parseFloat(el.style.marginTop || "0");
      const naturalTop = el.offsetTop - curMargin;
      const desiredMargin = Math.max(0, want - naturalTop);
      if (Math.abs(desiredMargin - curMargin) > 1) {
        el.style.marginTop = `${desiredMargin}px`;
        changed = true;
      }
      lastBottom = el.offsetTop + el.offsetHeight + 8;
    }
    if (changed) force((n) => n + 1);
  }, [threads, positions]);

  return (
    <div style={{ position: "relative", padding: "6px 8px 200px" }}>
      {threads.map((t) => (
        <Card
          key={t.id}
          ref={(el: HTMLDivElement | null) => {
            if (el) cardRefs.current.set(t.id, el);
            else cardRefs.current.delete(t.id);
          }}
          thread={t}
          pinned={pinnedId === t.id}
          active={activeId === t.id}
          canComment={canComment}
          onPin={() => onPin(pinnedId === t.id ? null : t.id)}
          onHoverIn={() => onHover(t.id)}
          onHoverOut={() => onHover(null)}
          onReply={(body) => onReply(body, null, t.id)}
          onResolve={(resolved) => onResolve(t.id, resolved)}
          onDelete={() => onDelete(t.id)}
          onReact={(emoji) => onReact(emoji, t.id)}
        />
      ))}

      {draft ? (
        <DraftCard
          onSubmit={onSubmitDraft}
          onCancel={onCancelDraft}
        />
      ) : null}

      {threads.length === 0 && !draft ? (
        <div style={{ padding: "10px", color: "#aaa", fontSize: 12 }}>
          No comments yet. Select text in the document to start a thread.
        </div>
      ) : null}
    </div>
  );
}

const Card = forwardRef<
  HTMLDivElement,
  {
    thread: Thread;
    pinned: boolean;
    active: boolean;
    canComment: boolean;
    onPin: () => void;
    onHoverIn: () => void;
    onHoverOut: () => void;
    onReply: (body: string) => Promise<boolean>;
    onResolve: (resolved: boolean) => void;
    onDelete: () => void;
    onReact: (emoji: string) => void;
  }
>(function Card(
  { thread: t, pinned, active, canComment, onPin, onHoverIn, onHoverOut, onReply, onResolve, onDelete, onReact },
  ref
) {
  const [replyText, setReplyText] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);

  const border = t.orphaned
    ? "1px dashed #d99"
    : pinned
      ? "1px solid #111"
      : active
        ? "1px solid #f1c40f"
        : "1px solid #e2e2e2";

  return (
    <div
      ref={ref}
      onMouseEnter={onHoverIn}
      onMouseLeave={onHoverOut}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-no-pin]")) return;
        onPin();
      }}
      style={{
        background: "#fff",
        border,
        borderRadius: 7,
        marginBottom: 7,
        fontSize: 12,
        cursor: "pointer",
        overflow: "hidden",
        opacity: t.resolved ? 0.6 : 1,
        boxShadow: pinned ? "0 3px 14px rgba(0,0,0,.18)" : active ? "0 2px 10px rgba(0,0,0,.13)" : "none",
      }}
    >
      <div style={{ display: "flex", gap: 7, padding: "8px 9px" }}>
        {t.author_avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.author_avatar} alt="" width={24} height={24} style={{ borderRadius: "50%", flexShrink: 0 }} />
        ) : null}
        <div style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 700, color: "#222" }}>{t.author ?? "someone"}</span>{" "}
          <span style={{ color: "#999", fontSize: 10.5 }}>{fmtTime(t.created_at)}</span>{" "}
          {t.resolved ? <Badge kind="res">resolved</Badge> : null}
          {t.orphaned ? <Badge kind="orp">orphaned</Badge> : null}
          <div style={{ color: "#222", marginTop: 2, fontFamily: "Georgia, serif", fontSize: 13, lineHeight: 1.45 }}>
            {t.body}
            {t.edited_at ? <span style={{ color: "#aaa", fontSize: 10.5 }}> (edited)</span> : null}
          </div>
          <Reactions reactions={t.reactions} canComment={canComment} onReact={onReact} />
        </div>
      </div>

      {t.replies.length ? (
        <div style={{ padding: "0 9px 6px", color: "#999", fontSize: 10.5 }}>
          {t.replies.length} repl{t.replies.length > 1 ? "ies" : "y"} ▾
        </div>
      ) : null}

      {pinned ? (
        <div style={{ borderTop: "1px solid #f1f1f1" }}>
          {t.replies.map((r) => (
            <div
              key={r.id}
              style={{ padding: "7px 9px 7px 26px", borderTop: "1px solid #f6f6f6", background: "#fcfcfc", display: "flex", gap: 6 }}
            >
              {r.author_avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.author_avatar} alt="" width={20} height={20} style={{ borderRadius: "50%" }} />
              ) : null}
              <div>
                <span style={{ fontWeight: 700, color: "#222" }}>{r.author ?? "someone"}</span>{" "}
                <span style={{ color: "#999", fontSize: 10.5 }}>{fmtTime(r.created_at)}</span>
                <div style={{ color: "#222", fontFamily: "Georgia, serif", fontSize: 13, lineHeight: 1.45 }}>{r.body}</div>
              </div>
            </div>
          ))}

          {/* actions row: resolve/unresolve, delete */}
          <div data-no-pin style={{ display: "flex", gap: 10, padding: "6px 9px", fontSize: 11, color: "#888", borderTop: "1px solid #f6f6f6" }}>
            {canComment ? (
              <span style={{ cursor: "pointer" }} onClick={() => onResolve(!t.resolved)}>
                {t.resolved ? "unresolve" : "resolve"}
              </span>
            ) : null}
            <span style={{ cursor: "pointer" }} onClick={() => onDelete()}>
              delete
            </span>
            {showEmoji ? (
              <span style={{ display: "flex", gap: 4 }}>
                {EMOJIS.map((e) => (
                  <span key={e} style={{ cursor: "pointer" }} onClick={() => { onReact(e); setShowEmoji(false); }}>
                    {e}
                  </span>
                ))}
              </span>
            ) : (
              <span style={{ cursor: "pointer" }} onClick={() => setShowEmoji(true)}>
                + react
              </span>
            )}
          </div>

          {canComment ? (
            <div data-no-pin style={{ padding: "7px 9px", borderTop: "1px solid #eee", background: "#fafafa" }}>
              <textarea
                value={replyText}
                placeholder="Reply…"
                onChange={(e) => setReplyText(e.target.value)}
                style={composerTextarea}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 5 }}>
                <button
                  disabled={!replyText.trim()}
                  onClick={async () => {
                    const ok = await onReply(replyText.trim());
                    if (ok) setReplyText("");
                  }}
                  style={composerBtn(!replyText.trim())}
                >
                  Reply
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ fontSize: 10.5, color: "#aaa", padding: "0 9px 8px" }}>
          click to {t.orphaned ? "view" : "reply"}…
        </div>
      )}
    </div>
  );
});

function DraftCard({ onSubmit, onCancel }: { onSubmit: (body: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div style={{ background: "#fff", border: "1px solid #111", borderRadius: 7, marginBottom: 7, padding: "8px 9px", boxShadow: "0 3px 14px rgba(0,0,0,.18)" }}>
      <textarea ref={ref} value={text} placeholder="Comment…" onChange={(e) => setText(e.target.value)} style={composerTextarea} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
        <button onClick={onCancel} style={{ font: "inherit", background: "transparent", border: "1px solid #ccc", borderRadius: 4, padding: "3px 9px", cursor: "pointer" }}>
          Cancel
        </button>
        <button disabled={!text.trim()} onClick={() => onSubmit(text.trim())} style={composerBtn(!text.trim())}>
          Comment
        </button>
      </div>
    </div>
  );
}

function Reactions({ reactions, canComment, onReact }: { reactions: Reaction[]; canComment: boolean; onReact: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 5 }} data-no-pin>
      {reactions.map((r) => (
        <span
          key={r.emoji}
          title={r.authors.join(", ")}
          onClick={() => canComment && onReact(r.emoji)}
          style={{ fontSize: 11, border: "1px solid #e0e0e0", borderRadius: 9, padding: "0 6px", background: "#fafafa", cursor: canComment ? "pointer" : "default" }}
        >
          {r.emoji} {r.count}
        </span>
      ))}
      {canComment ? (
        open ? (
          <span style={{ display: "flex", gap: 3 }}>
            {EMOJIS.map((e) => (
              <span key={e} style={{ cursor: "pointer", fontSize: 13 }} onClick={() => { onReact(e); setOpen(false); }}>
                {e}
              </span>
            ))}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: "#999", cursor: "pointer", border: "1px solid #e0e0e0", borderRadius: 9, padding: "0 6px" }} onClick={() => setOpen(true)}>
            + react
          </span>
        )
      ) : null}
    </div>
  );
}

function Badge({ kind, children }: { kind: "res" | "orp"; children: React.ReactNode }) {
  const styles =
    kind === "res"
      ? { background: "#eaf3ec", color: "#5a7a64" }
      : { background: "#fbecec", color: "#b04a4a" };
  return (
    <span style={{ display: "inline-block", fontSize: 9.5, padding: "0 5px", borderRadius: 8, letterSpacing: ".03em", ...styles }}>
      {children}
    </span>
  );
}

// --------------------------- styles ---------------------------

// Viewer chrome bar — variant A (LOCKED 2026-06-13): same weights/colors as the
// page footer. Matches PlainShell's bar so both viewer paths share one chrome.
const barStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  height: "2.4rem",
  padding: "0 1.25rem",
  fontFamily: MONO,
  fontSize: 13,
  borderBottom: "1px solid #ccc",
  color: "#111",
  background: "#fff",
};

const stageStyle: React.CSSProperties = {
  display: "flex",
  height: "calc(100vh - 2.4rem)",
  background: "#fff",
};

const railStyle: React.CSSProperties = {
  width: 320,
  flexShrink: 0,
  borderLeft: "1px solid #e2e2e2",
  background: "#fbfbfb",
  position: "relative",
  overflowY: "auto",
  fontFamily: MONO,
};

const railHeadStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: "#fbfbfb",
  borderBottom: "1px solid #eee",
  padding: "6px 10px",
  fontSize: 11,
  color: "#666",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  zIndex: 5,
};

const docReactionsRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexWrap: "wrap",
  padding: "5px 10px",
  borderBottom: "1px solid #eee",
  background: "#fbfbfb",
};

const seltoolPickerStyle: React.CSSProperties = {
  position: "absolute",
  right: 36,
  top: 0,
  display: "flex",
  gap: 2,
  background: "#111",
  borderRadius: 7,
  padding: "3px 5px",
  boxShadow: "0 4px 14px rgba(0,0,0,.3)",
  whiteSpace: "nowrap",
};

const seltoolStyle: React.CSSProperties = {
  position: "absolute",
  right: 8,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  background: "#111",
  borderRadius: 7,
  padding: 4,
  boxShadow: "0 4px 14px rgba(0,0,0,.3)",
  zIndex: 30,
};

const seltoolBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  border: "none",
  background: "transparent",
  color: "#fff",
  fontSize: 15,
  cursor: "pointer",
  borderRadius: 5,
};

const composerTextarea: React.CSSProperties = {
  width: "100%",
  border: "1px solid #d4d4d4",
  borderRadius: 4,
  fontFamily: MONO,
  fontSize: 12,
  padding: 5,
  resize: "vertical",
  minHeight: 34,
};

function composerBtn(disabled: boolean): React.CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: 12,
    border: "1px solid #111",
    background: "#111",
    color: "#fff",
    borderRadius: 4,
    padding: "3px 11px",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.4 : 1,
  };
}
