"use client";

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildChromePalette, type ThemeSample, type ChromePalette } from "@/lib/docs/theme";
import CommentMarkdown from "@/lib/docs/comments/CommentMarkdown";

// CommentsShell — the THIRD React surface (birthday.md "Production
// architecture", "CHOSEN: variant B"). The google-docs-style comment rail. The
// user HTML stays in the origin-less sandboxed iframe (left); this rail lives in
// the shell (right) and talks to the injected overlay (raw?overlay=1) via
// postMessage:
//
//   shell → overlay: jh:anchors (resolve+paint), jh:reactions (chips+paint),
//                    jh:active (hover sync), jh:focus (pin/focus a key),
//                    jh:clearSelection, jh:ping
//   overlay → shell: jh:ready, jh:positions (highlight y → card alignment,
//                    docHeight → iframe sizing),
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
// Google-docs scroll model: the iframe is sized to the document's full content
// height (from jh:positions docHeight) so it never scrolls internally — the PAGE
// owns the one scrollbar. Cards sit in a margin column to the right of the doc at
// their highlight's document Y (with no-overlap clamping), so doc and comments
// scroll together as one surface. Cards expand in place to reply; show-resolved
// toggle; dashed orphan cards; Gravatar avatars; vertical selection toolbar (add
// comment + react). All persistence goes through /api/v1/docs/:slug/comments and
// /reactions; the API enforces permissions.

const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace`;
// The picker set — the curated brand emoji (birthday.md B11 example set). Every
// one is in the server's ALLOWED_EMOJI (lib/docs/reactions.ts); agents may also
// react with the wider allowed set, but the human picker stays small.
const EMOJIS = ["👍", "👎", "🎉", "❤️", "😄", "🚀", "👀"];

type ThemeMode = "auto" | "light" | "dark";
const THEME_MODE_KEY = "jh:theme-mode";
// Fallback dark base when a viewer FORCES dark on a doc we didn't sample as dark
// (a light doc, or before the overlay's first jh:theme). Real dark docs keep
// their own sampled colors so the chrome matches the page.
const DEFAULT_DARK: ThemeSample = { bg: "#0d1117", fg: "#c9d1d9", isDark: true };

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
  // Coarse SSR theme (from the stored HTML's unconditional html/body bg). Present
  // only when the server is confident the doc is dark — gives the shell a dark
  // initial paint so there's no light→dark flash before the overlay's jh:theme
  // refines it. Absent (null) → render today's light chrome.
  initialTheme: ThemeSample | null;
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
  // The doc's total content height (from the overlay). The iframe is sized to it
  // so the page owns the single scrollbar and doc + cards scroll as one surface.
  const [docHeight, setDocHeight] = useState(0);
  const [overlayReady, setOverlayReady] = useState(false);

  // Adaptive chrome (variant D). The server may hand us a coarse dark theme for
  // the initial paint (no flash); the overlay's jh:theme then refines/confirms it.
  const [theme, setTheme] = useState<ThemeSample | null>(props.initialTheme);
  // Viewer theme preference: "auto" (match the document — the default, and
  // today's behavior) or an explicit light/dark. Persisted per viewer in
  // localStorage as a GLOBAL preference (not per-doc). localStorage is
  // client-only, so we start "auto" for SSR and hydrate on mount.
  const [mode, setMode] = useState<ThemeMode>("auto");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_MODE_KEY);
      if (saved === "auto" || saved === "light" || saved === "dark") setMode(saved);
    } catch {
      /* localStorage blocked (private mode) — stay on auto. */
    }
  }, []);
  const chooseMode = useCallback((m: ThemeMode) => {
    setMode(m);
    try {
      localStorage.setItem(THEME_MODE_KEY, m);
    } catch {
      /* best effort — the choice still applies for this session. */
    }
  }, []);
  // The theme that actually drives the chrome. light → today's literal light
  // chrome (palette null); dark → variant-D palette from the doc's sampled dark
  // colors when it really is dark, else a default dark base; auto → dark only
  // when the doc sampled dark (unchanged behavior).
  const effectiveTheme: ThemeSample | null = useMemo(() => {
    if (mode === "light") return null;
    if (mode === "dark") return theme && theme.isDark ? theme : DEFAULT_DARK;
    return theme && theme.isDark ? theme : null;
  }, [mode, theme]);
  const palette: ChromePalette | null = useMemo(
    () => (effectiveTheme ? buildChromePalette(effectiveTheme) : null),
    [effectiveTheme]
  );
  const isDark = palette !== null;

  // Selection state (from the overlay) → the floating toolbar + a pending draft.
  // top is document-space Y — identical to the wrapper's coordinate space since
  // the iframe never scrolls internally.
  const [selection, setSelection] = useState<{ anchor: NonNullable<Anchor>; top: number } | null>(null);
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
          if (typeof d.docHeight === "number") setDocHeight(d.docHeight);
          break;
        case "jh:theme":
          // Adaptive chrome: the overlay sampled the doc's effective colors. Drive
          // the variant-D palette from it (only dark themes recolor the chrome;
          // light keeps today's literal chrome). Cheap + idempotent — re-emitted
          // on ready/load/settle; we just store the latest sample.
          if (typeof d.bg === "string") {
            setTheme({
              bg: d.bg,
              fg: typeof d.fg === "string" ? d.fg : "#c9d1d9",
              accent: typeof d.accent === "string" ? d.accent : undefined,
              isDark: !!d.isDark,
              gradient: !!d.gradient,
            });
          }
          break;
        case "jh:selection":
          if ((canComment || canReact) && d.anchor && d.anchor.exact) {
            setSelection({ anchor: d.anchor, top: d.rect?.top ?? 0 });
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
            // Tapping a highlight in the doc OPENS the rail focused on that
            // thread (variant A). On desktop this only matters if the rail was
            // collapsed; on mobile it's the core open affordance. The setter is
            // stable so this needs no extra effect deps.
            setRailOpen(true);
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

  // Handshake: the overlay fires jh:ready when its script runs, which can beat
  // this component's listener — the SSR'd iframe starts fetching before React
  // hydrates — and a missed ready means anchors are never sent. Ping until the
  // overlay answers (it replies to jh:ping with jh:ready).
  useEffect(() => {
    if (overlayReady) return;
    const t = setInterval(() => postToOverlay({ type: "jh:ping" }), 250);
    return () => clearInterval(t);
  }, [overlayReady, postToOverlay]);

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

  // ---- Responsive rail (variant A — right drawer) ----
  // DESKTOP (>768px): side-by-side as before; the toggle collapses/expands the
  // rail to reclaim width (default = open). MOBILE (<=768px): the doc iframe is
  // full-width and the rail is OFF by default; the toggle slides a full-height
  // drawer in from the right OVER the doc, with a scrim + ✕ close. The stage's
  // data-rail="open|closed" attribute drives both via the <style> rules below.
  // The selection toolbar stays SELECTION-GATED (unchanged) — the drawer/scrim
  // is the only new chrome.
  // Default rail visibility is decided by the effect below. A doc with ZERO
  // comments at load starts with the rail HIDDEN on every viewport (toggle to
  // open it and start the first thread); based on the load-time count so a live
  // comment change never clobbers a manual toggle.
  const hadCommentsAtLoad = props.initialThreads.length > 0;
  const [railOpen, setRailOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    // Desktop: open by default ONLY if the doc already has comments. Mobile:
    // always closed by default (the toggle opens the right drawer).
    const applyDefault = () => {
      setIsMobile(mq.matches);
      setRailOpen(!mq.matches && hadCommentsAtLoad);
    };
    applyDefault();
    mq.addEventListener("change", applyDefault);
    return () => mq.removeEventListener("change", applyDefault);
  }, [hadCommentsAtLoad]);
  // The count shown in the toggle: number of threads (visible roots).
  const commentCount = threads.length;

  // Google-docs behavior: focusing a card brings its highlighted text into view.
  // The sandboxed iframe can't scroll the page (it never scrolls internally and
  // its opaque origin blocks scrollIntoView propagation), so the shell scrolls
  // the window to the highlight's document Y when it's offscreen.
  const scrollHighlightIntoView = useCallback(
    (id: number) => {
      const y = positions[id];
      const stage = stageRef.current;
      if (y == null || !stage) return;
      const target = stage.getBoundingClientRect().top + window.scrollY + y;
      if (target < window.scrollY + 80 || target > window.scrollY + window.innerHeight - 120) {
        window.scrollTo({ top: Math.max(0, target - window.innerHeight / 3), behavior: "smooth" });
      }
    },
    [positions]
  );

  // When dark, expose the variant-D palette as CSS custom properties on the
  // wrapper. Every themed color below reads `var(--jh-x, <light-literal>)`, so
  // when the vars are UNSET (light docs / no theme) the bytes resolve to today's
  // exact light chrome — the no-regression guarantee. Transitions on these vars
  // make a late jh:theme refinement a smooth fade, not a hard snap.
  const themeVars = palette ? paletteVars(palette) : undefined;

  return (
    <div className="jh-shell" data-theme={isDark ? "dark" : "light"} style={themeVars}>
      <style>{RAIL_CSS}</style>
      <style>{JH_MD_CSS}</style>
      <div style={barStyle}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700 }}>
          {title}
        </span>
        <span style={{ flexShrink: 0, paddingLeft: "1.25rem", display: "flex", gap: "1.25rem", alignItems: "center", color: "var(--jh-bar-muted, #666)" }}>
          <ThemeToggle mode={mode} onChange={chooseMode} />
          <button
            type="button"
            className="jh-commentbtn"
            aria-pressed={railOpen}
            aria-label={`${railOpen ? "hide" : "show"} comments`}
            onClick={() => setRailOpen((o) => !o)}
            style={commentBtnStyle(railOpen)}
          >
            💬 {commentCount}
          </button>
          <a href={`/d/${encodeURIComponent(slug)}/history${tokenQuery}`} style={{ color: "var(--jh-bar-muted, #666)" }}>history</a>
          <span>made with <a href="/" style={{ color: "var(--jh-bar-muted, #666)" }}>justhtml.sh</a></span>
        </span>
      </div>

      <div ref={stageRef} className="jh-stage" data-rail={railOpen ? "open" : "closed"} style={stageStyle}>
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <iframe
            ref={iframeRef}
            title={title}
            src={rawSrc}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            style={{
              border: "none",
              width: "100%",
              // Sized to the doc's full content height so the iframe never scrolls
              // internally — the page scrollbar is the only one. Until the overlay's
              // first docHeight report, fall back to a viewport-height pane (a tall
              // doc scrolls inside the iframe for that first beat).
              height: docHeight || undefined,
              minHeight: "calc(100vh - 2.4rem)",
              display: "block",
              background: "var(--jh-stage-bg, #fff)",
            }}
          />
          {/* selection toolbar — overlaid on the docwrap at the selection's
              document Y, so it scrolls with the page. Shows on selection when
              the viewer can comment OR react (react-only viewers still get the
              react affordance). */}
          {selection && (canComment || canReact) ? (
            <SelectionToolbar
              top={selection.top}
              canComment={canComment}
              canReact={canReact}
              onComment={() => {
                // Open the rail so the draft composer is actually visible — on a
                // doc with no comments (desktop) or on mobile the rail starts
                // closed, and a draft dropped into a hidden rail looks like a no-op.
                setRailOpen(true);
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

        {/* Scrim — only visible on mobile when the drawer is open (CSS-gated to
            <=768px). Tapping it closes the drawer. */}
        <div
          className="jh-scrim"
          data-open={railOpen ? "1" : undefined}
          onClick={() => setRailOpen(false)}
          style={scrimStyle}
        />

        <aside className="jh-rail" style={railStyle}>
          <div className="jh-railhead" style={railHeadStyle}>
            <span>
              {visibleThreads.length} comment{visibleThreads.length !== 1 ? "s" : ""}
            </span>
            <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span style={{ cursor: "pointer", color: "var(--jh-rail-muted, #888)" }} onClick={() => setShowResolved((s) => !s)}>
                {showResolved ? "hide resolved" : "show resolved"}
              </span>
              {/* Close (✕) — the drawer's close affordance. Hidden on desktop
                  via CSS (the bar toggle is the collapse control there). */}
              <button
                type="button"
                className="jh-railclose"
                aria-label="close comments"
                onClick={() => setRailOpen(false)}
                style={railCloseStyle}
              >
                ✕
              </button>
            </span>
          </div>

          {/* Doc-level reactions, compact in the rail header (birthday.md B11:
              "doc-level reactions render compactly in the rail header"). The
              react chip set + a mini picker for anyone who can react. */}
          {docReactions.length > 0 || canReact ? (
            <div className="jh-railrow" style={docReactionsRowStyle}>
              <span style={{ color: "var(--jh-rail-faint, #999)", fontSize: 10.5, marginRight: 2 }}>on this doc:</span>
              <Reactions
                reactions={docReactions}
                canComment={canReact}
                onReact={(e) => react(e, null)}
              />
            </div>
          ) : null}

          {!signedIn ? (
            <div className="jh-railrow" style={{ padding: "8px 10px", fontSize: 12, color: "var(--jh-rail-muted, #666)", borderBottom: "1px solid var(--jh-rail-line, #eee)" }}>
              <a href={`/login?next=${encodeURIComponent(`/d/${slug}`)}`} target="_blank" rel="noopener">Sign in</a> to comment.
            </div>
          ) : null}

          <RailCards
            threads={visibleThreads}
            positions={positions}
            aligned={!isMobile}
            docHeight={docHeight}
            pinnedId={pinnedId}
            activeId={activeId}
            canComment={canComment}
            draft={draft}
            onPin={(id) => {
              setPinnedId(id);
              setActiveId(id);
              // B14 rail → doc: focusing a card focuses its anchor in the document
              // (intensify + dim others); the shell scrolls the page if the
              // highlight is offscreen. Unpin clears focus.
              if (id != null) {
                postToOverlay({ type: "jh:focus", key: `c:${id}` });
                scrollHighlightIntoView(id);
              } else postToOverlay({ type: "jh:focus", key: null });
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
    </div>
  );
}

// Map the derived variant-D palette to the CSS custom properties consumed by the
// chrome styles below. Only set when dark; light leaves them unset so every
// `var(--jh-x, <literal>)` falls back to today's exact light value.
function paletteVars(p: ChromePalette): React.CSSProperties {
  return {
    ["--jh-bar-bg" as string]: p.barBg,
    ["--jh-bar-border" as string]: p.barBorder,
    ["--jh-bar-fg" as string]: p.barFg,
    ["--jh-bar-muted" as string]: p.barMuted,
    ["--jh-tog-border" as string]: p.togBorder,
    ["--jh-tog-bg" as string]: p.togBg,
    ["--jh-tog-fg" as string]: p.togFg,
    ["--jh-tog-on-border" as string]: p.togOnBorder,
    ["--jh-tog-on-bg" as string]: p.togOnBg,
    ["--jh-tog-on-fg" as string]: p.togOnFg,
    ["--jh-stage-bg" as string]: p.stageBg,
    ["--jh-rail-bg" as string]: p.railBg,
    ["--jh-rail-border" as string]: p.railBorder,
    ["--jh-rail-line" as string]: p.railLine,
    ["--jh-rail-muted" as string]: p.railMuted,
    ["--jh-rail-faint" as string]: p.railFaint,
    ["--jh-card-bg" as string]: p.cardBg,
    ["--jh-card-border" as string]: p.cardBorder,
    ["--jh-card-shadow" as string]: p.cardShadow,
    ["--jh-card-pin-border" as string]: p.cardPinBorder,
    ["--jh-card-pin-shadow" as string]: p.cardPinShadow,
    ["--jh-card-orphan-border" as string]: p.cardOrphanBorder,
    ["--jh-card-fg" as string]: p.cardFg,
    ["--jh-card-muted" as string]: p.cardMuted,
    ["--jh-card-faint" as string]: p.cardFaint,
    ["--jh-card-line" as string]: p.cardLine,
    ["--jh-card-line2" as string]: p.cardLine2,
    ["--jh-avatar-ring" as string]: p.avatarRing,
    ["--jh-avatar-bg" as string]: p.avatarBg,
    ["--jh-reply-bg" as string]: p.replyBg,
    ["--jh-composer-bg" as string]: p.composerBg,
    ["--jh-input-border" as string]: p.inputBorder,
    ["--jh-input-bg" as string]: p.inputBg,
    ["--jh-btn-border" as string]: p.btnBorder,
    ["--jh-btn-bg" as string]: p.btnBg,
    ["--jh-btn-fg" as string]: p.btnFg,
    ["--jh-chip-border" as string]: p.chipBorder,
    ["--jh-chip-bg" as string]: p.chipBg,
    ["--jh-chip-mine-border" as string]: p.chipMineBorder,
    ["--jh-chip-mine-bg" as string]: p.chipMineBg,
    ["--jh-chip-mine-fg" as string]: p.chipMineFg,
    ["--jh-badge-res-bg" as string]: p.badgeResBg,
    ["--jh-badge-res-fg" as string]: p.badgeResFg,
    ["--jh-badge-orp-bg" as string]: p.badgeOrpBg,
    ["--jh-badge-orp-fg" as string]: p.badgeOrpFg,
    ["--jh-sel-bg" as string]: p.selBg,
    ["--jh-sel-border" as string]: p.selBorder,
    ["--jh-sel-fg" as string]: p.selFg,
    ["--jh-sel-shadow" as string]: p.selShadow,
    ["--jh-sel-hover" as string]: p.selHover,
    ["--jh-drawer-shadow" as string]: p.drawerShadow,
    ["--jh-scrim-bg" as string]: p.scrimBg,
  };
}

// --------------------------- subcomponents ---------------------------

// Light / dark / auto theme control in the chrome bar. Segmented, monospace,
// themed off the same --jh-tog-* vars as the comment toggle so it recolors in
// dark. "auto" (◐) matches the document; ☀/☾ force the choice and persist it.
const THEME_OPTS: { m: ThemeMode; glyph: string; label: string }[] = [
  { m: "light", glyph: "☀", label: "light" },
  { m: "dark", glyph: "☾", label: "dark" },
  { m: "auto", glyph: "◐", label: "auto (match the document)" },
];

function ThemeToggle({ mode, onChange }: { mode: ThemeMode; onChange: (m: ThemeMode) => void }) {
  return (
    <span role="group" aria-label="theme" style={themeToggleWrap}>
      {THEME_OPTS.map((o) => (
        <button
          key={o.m}
          type="button"
          title={o.label}
          aria-label={`theme: ${o.label}`}
          aria-pressed={mode === o.m}
          onClick={() => onChange(o.m)}
          style={themeSegStyle(mode === o.m)}
        >
          {o.glyph}
        </button>
      ))}
    </span>
  );
}

function SelectionToolbar({
  top,
  canComment,
  canReact,
  onComment,
  onReact,
}: {
  top: number;
  canComment: boolean;
  canReact: boolean;
  onComment: () => void;
  onReact: (emoji: string) => void;
}) {
  // Positioned at the selection's document Y (the iframe spans the docwrap at
  // full content height, so doc space == wrapper space) — it scrolls with the
  // page like the highlight it belongs to.
  const clampedTop = `max(8px, min(${Math.max(8, Math.round(top))}px, calc(100% - 84px)))`;
  const [picking, setPicking] = useState(false);
  return (
    <div style={{ ...seltoolStyle, top: clampedTop }}>
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
  aligned: boolean;
  docHeight: number;
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
    aligned,
    docHeight,
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
  const containerRef = useRef<HTMLDivElement>(null);
  // Height of the rail chrome above the cards list (header/reactions/sign-in
  // rows). Highlight Ys are measured from the document top, which is also the
  // rail's top, so card offsets inside this container subtract it to line up.
  const [chromeOffset, setChromeOffset] = useState(0);
  const [, force] = useState(0);

  useEffect(() => {
    // Mobile (drawer, no doc alongside): stack cards normally — clear any Y offset
    // from a previous desktop layout so nothing is stranded below an empty drawer.
    if (!aligned) {
      for (const t of threads) {
        const el = cardRefs.current.get(t.id);
        if (el && el.style.marginTop) el.style.marginTop = "";
      }
      return;
    }
    // Desktop: re-clamp after layout — walk cards in DOM order, push each down so
    // its top is >= previous card's bottom + gap, and >= its anchor y. Doc and
    // cards share the one page scroll, so a card sits next to its highlight.
    const off = containerRef.current?.offsetTop ?? 0;
    setChromeOffset(off);
    const anchored = threads.filter((t) => t.group === "anchored");
    let lastBottom = 0;
    let changed = false;
    for (const t of anchored) {
      const el = cardRefs.current.get(t.id);
      if (!el) continue;
      const y = positions[t.id];
      const want = Math.max(lastBottom, y != null ? Math.max(0, y - off) : lastBottom);
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
  }, [threads, positions, aligned]);

  return (
    <div
      ref={containerRef}
      data-jh-cards=""
      style={{ position: "relative", padding: "6px 8px 200px", minHeight: aligned && docHeight ? Math.max(0, docHeight - chromeOffset) : undefined }}
    >
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
        aligned ? (
          // Place the composer at the selection's document Y so it opens next to
          // the selected text and scrolls with it.
          <div style={{ position: "absolute", left: 8, right: 8, top: Math.max(0, draft.top - chromeOffset) }}>
            <DraftCard onSubmit={onSubmitDraft} onCancel={onCancelDraft} />
          </div>
        ) : (
          <DraftCard onSubmit={onSubmitDraft} onCancel={onCancelDraft} />
        )
      ) : null}

      {threads.length === 0 && !draft ? (
        <div style={{ padding: "10px", color: "var(--jh-card-faint, #aaa)", fontSize: 12 }}>
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
    ? "1px dashed var(--jh-card-orphan-border, #d99)"
    : pinned
      ? "1px solid var(--jh-card-pin-border, #111)"
      : active
        ? "1px solid var(--jh-card-active-border, #f1c40f)"
        : "1px solid var(--jh-card-border, #e2e2e2)";

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
        background: "var(--jh-card-bg, #fff)",
        border,
        borderRadius: 7,
        marginBottom: 7,
        fontSize: 12,
        cursor: "pointer",
        overflow: "hidden",
        opacity: t.resolved ? 0.6 : 1,
        boxShadow: pinned
          ? "var(--jh-card-pin-shadow, 0 3px 14px rgba(0,0,0,.18))"
          : active
            ? "0 2px 10px rgba(0,0,0,.13)"
            : "var(--jh-card-shadow, none)",
        transition: CHROME_TRANSITION,
      }}
    >
      <div style={{ display: "flex", gap: 7, padding: "8px 9px" }}>
        {t.author_avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.author_avatar} alt="" width={24} height={24} style={{ borderRadius: "50%", flexShrink: 0, boxShadow: "0 0 0 1px var(--jh-avatar-ring, transparent)" }} />
        ) : null}
        <div style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 700, color: "var(--jh-card-fg, #222)" }}>{t.author ?? "someone"}</span>{" "}
          <span style={{ color: "var(--jh-card-muted, #999)", fontSize: 10.5 }}>{fmtTime(t.created_at)}</span>
          {t.edited_at ? <span style={{ color: "var(--jh-card-faint, #aaa)", fontSize: 10.5 }}> (edited)</span> : null}{" "}
          {t.resolved ? <Badge kind="res">resolved</Badge> : null}
          {t.orphaned ? <Badge kind="orp">orphaned</Badge> : null}
          <div style={{ marginTop: 2 }}>
            <CommentMarkdown body={t.body} />
          </div>
          <Reactions reactions={t.reactions} canComment={canComment} onReact={onReact} />
        </div>
      </div>

      {t.replies.length ? (
        <div style={{ padding: "0 9px 6px", color: "var(--jh-card-muted, #999)", fontSize: 10.5 }}>
          {t.replies.length} repl{t.replies.length > 1 ? "ies" : "y"} ▾
        </div>
      ) : null}

      {pinned ? (
        <div style={{ borderTop: "1px solid var(--jh-card-line, #f1f1f1)" }}>
          {t.replies.map((r) => (
            <div
              key={r.id}
              style={{ padding: "7px 9px 7px 26px", borderTop: "1px solid var(--jh-card-line2, #f6f6f6)", background: "var(--jh-reply-bg, #fcfcfc)", display: "flex", gap: 6 }}
            >
              {r.author_avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.author_avatar} alt="" width={20} height={20} style={{ borderRadius: "50%", boxShadow: "0 0 0 1px var(--jh-avatar-ring, transparent)" }} />
              ) : null}
              <div style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 700, color: "var(--jh-card-fg, #222)" }}>{r.author ?? "someone"}</span>{" "}
                <span style={{ color: "var(--jh-card-muted, #999)", fontSize: 10.5 }}>{fmtTime(r.created_at)}</span>
                <CommentMarkdown body={r.body} />
              </div>
            </div>
          ))}

          {/* actions row: resolve/unresolve, delete */}
          <div data-no-pin style={{ display: "flex", gap: 10, padding: "6px 9px", fontSize: 11, color: "var(--jh-card-muted, #888)", borderTop: "1px solid var(--jh-card-line2, #f6f6f6)" }}>
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
            <div data-no-pin style={{ padding: "7px 9px", borderTop: "1px solid var(--jh-rail-line, #eee)", background: "var(--jh-composer-bg, #fafafa)" }}>
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
        <div style={{ fontSize: 10.5, color: "var(--jh-card-faint, #aaa)", padding: "0 9px 8px" }}>
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
    <div style={{ background: "var(--jh-card-bg, #fff)", border: "1px solid var(--jh-card-pin-border, #111)", borderRadius: 7, marginBottom: 7, padding: "8px 9px", boxShadow: "var(--jh-card-pin-shadow, 0 3px 14px rgba(0,0,0,.18))" }}>
      <textarea ref={ref} value={text} placeholder="Comment…" onChange={(e) => setText(e.target.value)} style={composerTextarea} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
        <button onClick={onCancel} style={{ font: "inherit", color: "var(--jh-card-fg, inherit)", background: "transparent", border: "1px solid var(--jh-input-border, #ccc)", borderRadius: 4, padding: "3px 9px", cursor: "pointer" }}>
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
          style={{ fontSize: 11, color: "var(--jh-card-fg, inherit)", border: "1px solid var(--jh-chip-border, #e0e0e0)", borderRadius: 9, padding: "0 6px", background: "var(--jh-chip-bg, #fafafa)", cursor: canComment ? "pointer" : "default" }}
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
          <span style={{ fontSize: 11, color: "var(--jh-card-muted, #999)", cursor: "pointer", border: "1px solid var(--jh-chip-border, #e0e0e0)", borderRadius: 9, padding: "0 6px" }} onClick={() => setOpen(true)}>
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
      ? { background: "var(--jh-badge-res-bg, #eaf3ec)", color: "var(--jh-badge-res-fg, #5a7a64)" }
      : { background: "var(--jh-badge-orp-bg, #fbecec)", color: "var(--jh-badge-orp-fg, #b04a4a)" };
  return (
    <span style={{ display: "inline-block", fontSize: 9.5, padding: "0 5px", borderRadius: 8, letterSpacing: ".03em", ...styles }}>
      {children}
    </span>
  );
}

// --------------------------- responsive rail (variant A) ---------------------------

// Inline styles can't express media queries, so the breakpoint-dependent layout
// lives here, keyed off the stage's data-rail attribute. Desktop (>768px): the
// comments are a transparent margin column beside the doc (no rail chrome — the
// google-docs look) sharing the page scroll; collapsing hides it to reclaim
// width; the scrim + ✕ are display:none. Mobile (<=768px): the doc is full-width
// and the comments are an off-canvas right drawer, viewport-fixed below the
// sticky bar (the page behind it owns document scrolling), with its own card
// scroll and a scrim.
const RAIL_CSS = `
.jh-stage[data-rail="closed"] .jh-rail { display: none; }
.jh-railclose { display: none; }
.jh-scrim { display: none; }
.jh-scrim[data-open="1"] { opacity: 1 !important; pointer-events: auto !important; }

@media (min-width: 769px) {
  /* No rail chrome on desktop — cards float in the page's right margin. The
     header rows keep their inline (drawer) styling for mobile, so strip the
     sticky positioning + surfaces here. */
  .jh-railhead, .jh-railrow { position: static !important; background: transparent !important; border-bottom: none !important; }
}

@media (max-width: 768px) {
  /* The rail carries an inline style (position:relative, width:320) for the
     desktop side-by-side flex layout; inline styles beat stylesheet specificity,
     so the off-canvas drawer overrides need !important here. */
  .jh-stage .jh-rail {
    position: fixed !important;
    top: 2.4rem; right: 0; bottom: 0;
    width: min(86vw, 340px) !important;
    overflow-y: auto;
    background: var(--jh-rail-bg, #fbfbfb);
    transform: translateX(100%);
    transition: transform .24s ease;
    border-left: 1px solid var(--jh-rail-border, #ccc);
    box-shadow: -6px 0 24px var(--jh-drawer-shadow, rgba(0,0,0,.18));
    z-index: 25;
  }
  /* Keep the drawer in the DOM when closed (off-screen) so the doc is genuinely
     full-width — the bug fix. */
  .jh-stage[data-rail="closed"] .jh-rail { display: block; }
  .jh-stage[data-rail="open"] .jh-rail { transform: translateX(0); }
  .jh-railclose { display: inline-block; }
  .jh-scrim { display: block; position: fixed !important; }
}
`;

// Markdown styling for rendered comment bodies (CommentMarkdown -> .jh-md). The
// "familiar prose" treatment: keeps the rail's serif body, lifts structure with real
// bold, mono inline-code chips, a neutral scrolling code slab, indented lists, and a
// left-rule blockquote. Every color reads the --jh-card-* vars (set by paletteVars in
// dark, falling back to the light literals) so it themes both ways, and pre/table
// scroll so wide code never widens the ~320px rail.
const JH_MD_CSS = `
.jh-md { font-family: Georgia, "Times New Roman", serif; font-size: 13px; line-height: 1.5; color: var(--jh-card-fg, #222); overflow-wrap: anywhere; }
.jh-md > :first-child { margin-top: 0; }
.jh-md > :last-child { margin-bottom: 0; }
.jh-md p { margin: 0 0 8px; }
.jh-md strong { font-weight: 700; }
.jh-md em { font-style: italic; }
.jh-md a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.jh-md h1, .jh-md h2, .jh-md h3, .jh-md h4, .jh-md h5, .jh-md h6 { font-weight: 700; line-height: 1.3; margin: 12px 0 6px; }
.jh-md h1 { font-size: 1.25em; }
.jh-md h2 { font-size: 1.15em; }
.jh-md h3 { font-size: 1.05em; }
.jh-md h4, .jh-md h5, .jh-md h6 { font-size: 1em; }
.jh-md ul, .jh-md ol { margin: 0 0 8px; padding-left: 20px; }
.jh-md li { margin: 0 0 4px; }
.jh-md li:last-child { margin-bottom: 0; }
.jh-md li::marker { color: var(--jh-card-muted, #999); }
.jh-md li > ul, .jh-md li > ol { margin: 4px 0 0; }
.jh-md code { font-family: ${MONO}; font-size: 0.86em; background: var(--jh-chip-bg, #ececec); border-radius: 4px; padding: 1px 4px; overflow-wrap: anywhere; word-break: break-word; }
.jh-md pre { margin: 0 0 8px; padding: 8px 10px; background: var(--jh-chip-bg, #ececec); border: 1px solid var(--jh-card-border, #e2e2e2); border-radius: 6px; overflow-x: auto; max-width: 100%; }
.jh-md pre code { display: block; padding: 0; background: none; border-radius: 0; font-size: 12px; line-height: 1.45; white-space: pre; word-break: normal; overflow-wrap: normal; }
.jh-md blockquote { margin: 0 0 8px; padding: 2px 0 2px 10px; border-left: 2px solid var(--jh-card-border, #e2e2e2); color: var(--jh-card-muted, #999); }
.jh-md blockquote :last-child { margin-bottom: 0; }
.jh-md table { display: block; overflow-x: auto; max-width: 100%; border-collapse: collapse; font-size: 12px; margin: 0 0 8px; }
.jh-md th, .jh-md td { border: 1px solid var(--jh-card-border, #e2e2e2); padding: 3px 6px; text-align: left; }
.jh-md hr { border: none; border-top: 1px solid var(--jh-card-border, #e2e2e2); margin: 10px 0; }
`;

// --------------------------- styles ---------------------------

// Transition applied to every themed chrome color so a late jh:theme refinement
// (e.g. SSR coarse theme → overlay-confirmed colors) fades instead of snapping.
const CHROME_TRANSITION = "background-color .22s ease, color .22s ease, border-color .22s ease, box-shadow .22s ease";

function commentBtnStyle(pressed: boolean): React.CSSProperties {
  return {
    font: "inherit",
    fontSize: 12,
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    border: pressed ? "1px solid var(--jh-tog-on-border, #111)" : "1px solid var(--jh-tog-border, #ccc)",
    background: pressed ? "var(--jh-tog-on-bg, #111)" : "var(--jh-tog-bg, #fafafa)",
    color: pressed ? "var(--jh-tog-on-fg, #fff)" : "var(--jh-tog-fg, #111)",
    borderRadius: 6,
    padding: "2px 9px",
    cursor: "pointer",
    lineHeight: 1.6,
    transition: CHROME_TRANSITION,
  };
}

const themeToggleWrap: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 22,
  border: "1px solid var(--jh-tog-border, #ccc)",
  borderRadius: 6,
  overflow: "hidden",
};

function themeSegStyle(on: boolean): React.CSSProperties {
  return {
    font: "inherit",
    fontSize: 12,
    lineHeight: 1,
    minWidth: 24,
    height: "100%",
    padding: "0 6px",
    border: "none",
    cursor: "pointer",
    background: on ? "var(--jh-tog-on-bg, #111)" : "var(--jh-tog-bg, #fafafa)",
    color: on ? "var(--jh-tog-on-fg, #fff)" : "var(--jh-tog-fg, #111)",
    transition: CHROME_TRANSITION,
  };
}

const scrimStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "var(--jh-scrim-bg, rgba(0,0,0,.32))",
  zIndex: 20,
  opacity: 0,
  pointerEvents: "none",
  transition: "opacity .2s ease",
};

const railCloseStyle: React.CSSProperties = {
  cursor: "pointer",
  color: "var(--jh-rail-muted, #888)",
  fontSize: 15,
  lineHeight: 1,
  border: "none",
  background: "transparent",
  padding: "0 2px",
};

// Viewer chrome bar — variant A (LOCKED 2026-06-13): same weights/colors as the
// page footer. Matches PlainShell's bar so both viewer paths share one chrome.
// Sticky so it stays put while the page scrolls the document (google-docs feel).
const barStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 40,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  height: "2.4rem",
  padding: "0 1.25rem",
  fontFamily: MONO,
  fontSize: 13,
  borderBottom: "1px solid var(--jh-bar-border, #ccc)",
  color: "var(--jh-bar-fg, #111)",
  background: "var(--jh-bar-bg, #fff)",
  transition: CHROME_TRANSITION,
};

// The stage grows with the document (the iframe is sized to the doc's content
// height) so the page owns the one scrollbar; min-height keeps short docs
// filling the viewport.
const stageStyle: React.CSSProperties = {
  display: "flex",
  minHeight: "calc(100vh - 2.4rem)",
  background: "var(--jh-stage-bg, #fff)",
  transition: CHROME_TRANSITION,
};

// Desktop: not a chrome "rail" — a transparent margin column beside the doc that
// scrolls with the page; cards float in it at their highlight's document Y. The
// mobile drawer surface (bg/border/scroll) comes from RAIL_CSS.
const railStyle: React.CSSProperties = {
  width: 320,
  flexShrink: 0,
  position: "relative",
  fontFamily: MONO,
  transition: CHROME_TRANSITION,
};

const railHeadStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: "var(--jh-rail-bg, #fbfbfb)",
  borderBottom: "1px solid var(--jh-rail-line, #eee)",
  padding: "6px 10px",
  fontSize: 11,
  color: "var(--jh-rail-muted, #666)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  zIndex: 5,
  transition: CHROME_TRANSITION,
};

const docReactionsRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexWrap: "wrap",
  padding: "5px 10px",
  borderBottom: "1px solid var(--jh-rail-line, #eee)",
  background: "var(--jh-rail-bg, #fbfbfb)",
  transition: CHROME_TRANSITION,
};

const seltoolPickerStyle: React.CSSProperties = {
  position: "absolute",
  right: 36,
  top: 0,
  display: "flex",
  gap: 2,
  background: "var(--jh-sel-bg, #111)",
  borderRadius: 7,
  padding: "3px 5px",
  boxShadow: "0 4px 14px var(--jh-sel-shadow, rgba(0,0,0,.3))",
  whiteSpace: "nowrap",
};

const seltoolStyle: React.CSSProperties = {
  position: "absolute",
  right: 8,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  background: "var(--jh-sel-bg, #111)",
  border: "1px solid var(--jh-sel-border, #111)",
  borderRadius: 7,
  padding: 4,
  boxShadow: "0 4px 14px var(--jh-sel-shadow, rgba(0,0,0,.3))",
  zIndex: 30,
};

const seltoolBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  border: "none",
  background: "transparent",
  color: "var(--jh-sel-fg, #fff)",
  fontSize: 15,
  cursor: "pointer",
  borderRadius: 5,
};

const composerTextarea: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--jh-input-border, #d4d4d4)",
  borderRadius: 4,
  fontFamily: MONO,
  fontSize: 12,
  padding: 5,
  resize: "vertical",
  minHeight: 34,
  background: "var(--jh-input-bg, #fff)",
  color: "var(--jh-card-fg, #222)",
};

function composerBtn(disabled: boolean): React.CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: 12,
    border: "1px solid var(--jh-btn-border, #111)",
    background: "var(--jh-btn-bg, #111)",
    color: "var(--jh-btn-fg, #fff)",
    borderRadius: 4,
    padding: "3px 11px",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.4 : 1,
  };
}
