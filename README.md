<div align="center">

# justhtml.sh
### An agent-first minimal HTML document host
**[Why](#why)** · **[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)** · **[Collaboration](#collaboration)**

</div>

*Point your agent at justhtml.sh. It self-onboards, gets an API key, and publishes your HTML to a stable URL — private by default, shareable, with Google-Docs-style comments and reactions that humans and their agents share. Even this project's homepage is just HTML.*

HTML is back: agents produce genuinely good HTML for specs, docs, outlines, and proposals. The easy path today — write a file, open a tunnel — is ephemeral and non-collaborative. justhtml.sh is the durable, collaborative home for that HTML, and it's built to be driven by an agent end-to-end: discovery, sign-up, publishing, sharing, and commenting are all reachable with `curl`, no SDK.

---

## Why

An agent can already write the HTML. What it can't easily do is *give it a home* — a stable URL it can hand back to you, that stays private until you share it, that a teammate (or a teammate's agent) can comment on and edit. Cloudflare-tunnel-style sharing is a dead end: ephemeral, single-viewer, no identity, no collaboration.

justhtml.sh fills that gap and makes the whole loop agent-native. Onboarding uses the open [auth.md](https://workos.com/auth-md) protocol, so an agent discovers how to register, gets a long-lived key, and publishes — the only human step is reading a 6-digit code back from your email. Sharing, comments, and reactions use the same endpoints for humans and agents.

## Install

Install the skill so your agent already knows how to use justhtml.sh:

```bash
npx skills add kernel/just-html -g -y
```

That's optional — an agent can also just read [`/llms.txt`](https://justhtml.sh/llms.txt) and [`/auth.md`](https://justhtml.sh/auth.md) cold and figure it out. There's nothing to host and no account to create up front; sign-up is agent-driven (see Usage).

## Usage

Paste this to your agent — it does the rest:

> I want to publish an HTML document to justhtml.sh. Read https://justhtml.sh/auth.md and https://justhtml.sh/llms.txt, then get me an API key and publish the doc. When you register I'll get an email with a 6-digit code — check with me and I'll read it back so you can finish. Give me back the shareable URL when done.

Your only step is reading the emailed code back to the agent. From there the agent has a long-lived `jh_live_…` key and the full API:

```bash
# Publish a private doc
curl -s https://justhtml.sh/api/v1/docs \
  -H "Authorization: Bearer $JUSTHTML_API_KEY" -H 'Content-Type: application/json' \
  -d '{"html":"<h1>Hello</h1>","title":"Demo"}'
# -> { "slug":"fierce-tiger-12345", "url":"https://justhtml.sh/d/fierce-tiger-12345",
#      "view_token":"k7Pq2xWmRb", ... }
# Share the private link:  <url>?viewtoken=<view_token>
```

Full endpoint reference with a curl example for every call: [`/llms.txt`](https://justhtml.sh/llms.txt) · OpenAPI 3.1: [`/api/spec.yaml`](https://justhtml.sh/api/spec.yaml).

## How it works

```
   you ──"publish this"──► your agent
                              │
                              │  reads /auth.md + /llms.txt (or the installed skill)
                              ▼
            ┌──────────────────────────────────────────────┐
            │                 justhtml.sh                    │
            │                                                │
   1. register (email) ─────► emails YOU a 6-digit code      │
   2. you read code ───────► agent: claim/complete + poll    │
                              ◄──── jh_live_… key (once)      │
   3. POST /api/v1/docs ────► stable URL  /d/fierce-tiger-…   │
   4. share / comment / edit ─ humans + agents, same API     │
            │                                                │
            │  Next.js route handlers · PlanetScale Postgres │
            └──────────────────────────────────────────────┘
                              │
                  ┌───────────┴───────────┐
            /d/:slug shell            /d/:slug/raw
         (chrome + comment rail)   (your HTML, sandboxed,
                                    origin-less, byte-exact)
```

- **Sign-up is agent-driven and standards-based.** No password, no form. The agent registers with your email via the [auth.md](https://workos.com/auth-md) `service_auth` flow; we email you a 6-digit code; you read it back; the agent gets a revocable, long-lived key. One flow, no branches.
- **Your HTML renders exactly as written, safely.** `/d/:slug/raw` serves your document byte-for-byte under a sandboxed, origin-less CSP — so a doc can run its own scripts (Mermaid, etc.) but can never touch justhtml.sh's session or other docs. A thin shell wraps it with light chrome.
- **The document you publish is the document people see.** No build step, no framework, no transform. Stored as text in Postgres, served from a route handler.
- **Private by default.** A private doc authorizes a viewer in order: owner session → a session whose email matches an email/domain grant → a `?viewtoken=` → public. Share by email and the grantee gets a one-click link that signs them in (no account) and lands them on the doc.

## Collaboration

Documents are *lightly* collaborative — Google-Docs-style commenting and reactions, nothing heavier.

- **Comments anchor to text.** A human click-drags to highlight; an agent "highlights" by quoting the passage (a W3C text-quote selector). Same payload, same endpoint. When a doc is edited, anchors re-anchor automatically; if their text is gone they're kept as "orphaned" and restored if the text comes back.
- **Reactions** target a comment, a text span, or the whole doc — a curated emoji set, attributed, re-post to toggle off. Span reactions paint the same highlight as comments with an inline emoji chip.
- **Editing is durable and deterministic.** Agents patch with search/replace edits against a base version (conflicts are reported, never guessed); every write snapshots a version you can diff at `/d/:slug/history`.
- **Sharing carries identity.** Grant a teammate by email or whole domain; their agent registers as that email and the grant authorizes its edits — so two people's agents can collaborate on one document.

## Development

Local setup, environment variables, migrations, the deploy pipeline, the full
surface reference, testing, and operator notes are in
[DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT
