"use client";

import { useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";

// History viewer — the SECOND of the two designated React surfaces (birthday.md:
// "viewer shell, history"). Renders the version list plus an on-demand diff with
// @pierre/diffs, toggleable between unified and split layouts. All access control
// already happened on the server; this component only receives data the viewer is
// allowed to see (version metadata + precomputed unified patches between adjacent
// versions). It ships zero document html into executable scope of our origin — the
// patches are plain strings rendered as code, never as live HTML.

export type VersionMeta = {
  version: number;
  edit_kind: "create" | "patch" | "rewrite";
  created_at: string;
  bytes: number;
  // Unified patch from the previous retained version → this version. Undefined for
  // the oldest retained version (nothing to diff against).
  patch?: string;
};

type Props = {
  slug: string;
  title: string;
  currentVersion: number;
  versions: VersionMeta[]; // newest first
};

const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace`;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return iso;
  }
}

export default function HistoryClient({ slug, title, currentVersion, versions }: Props) {
  // Default selection: the newest version that has a diff (i.e. not the lone
  // oldest snapshot). Falls back to the newest version regardless.
  const firstWithPatch = versions.find((v) => v.patch !== undefined);
  const [selected, setSelected] = useState<number>(
    firstWithPatch?.version ?? versions[0]?.version ?? currentVersion
  );
  const [split, setSplit] = useState<boolean>(false);

  const sel = versions.find((v) => v.version === selected);

  return (
    <div style={{ fontFamily: MONO, fontSize: 13, lineHeight: 1.55 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: "0.5rem",
          marginBottom: "1rem",
        }}
      >
        <div>
          <strong>{title}</strong>{" "}
          <span style={{ opacity: 0.6 }}>
            — history (current v{currentVersion}, {versions.length} retained)
          </span>
        </div>
        <a href={`/d/${encodeURIComponent(slug)}${tokenSuffix()}`}>← back to document</a>
      </div>

      <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            minWidth: 220,
            borderRight: "1px solid rgba(127,127,127,0.3)",
            paddingRight: "1rem",
          }}
        >
          {versions.map((v) => {
            const isSel = v.version === selected;
            const hasDiff = v.patch !== undefined;
            return (
              <li key={v.version} style={{ marginBottom: "0.35rem" }}>
                <button
                  type="button"
                  disabled={!hasDiff}
                  onClick={() => hasDiff && setSelected(v.version)}
                  title={hasDiff ? "" : "oldest retained snapshot — nothing earlier to diff against"}
                  style={{
                    font: "inherit",
                    textAlign: "left",
                    width: "100%",
                    cursor: hasDiff ? "pointer" : "default",
                    background: isSel ? "rgba(127,127,127,0.18)" : "transparent",
                    border: "1px solid rgba(127,127,127,0.25)",
                    borderRadius: 4,
                    padding: "0.3rem 0.5rem",
                    color: "inherit",
                    opacity: hasDiff ? 1 : 0.55,
                  }}
                >
                  <div>
                    <strong>v{v.version}</strong>{" "}
                    <span style={{ opacity: 0.7 }}>{v.edit_kind}</span>
                    {v.version === currentVersion ? (
                      <span style={{ opacity: 0.7 }}> (current)</span>
                    ) : null}
                  </div>
                  <div style={{ opacity: 0.6, fontSize: 11 }}>
                    {fmtDate(v.created_at)} · {fmtBytes(v.bytes)}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>

        <div style={{ flex: 1, minWidth: 320 }}>
          <div style={{ marginBottom: "0.6rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <span style={{ opacity: 0.7 }}>layout:</span>
            <button
              type="button"
              onClick={() => setSplit(false)}
              style={toggleStyle(!split)}
            >
              unified
            </button>
            <button type="button" onClick={() => setSplit(true)} style={toggleStyle(split)}>
              split
            </button>
          </div>

          {sel && sel.patch !== undefined ? (
            <PatchDiff
              key={`${sel.version}-${split ? "split" : "unified"}`}
              patch={sel.patch}
              options={{ diffStyle: split ? "split" : "unified", themeType: "light" }}
            />
          ) : (
            <p style={{ opacity: 0.6 }}>
              No diff to show. This is the oldest retained snapshot.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function toggleStyle(active: boolean): React.CSSProperties {
  return {
    font: "inherit",
    cursor: "pointer",
    background: active ? "rgba(127,127,127,0.25)" : "transparent",
    border: "1px solid rgba(127,127,127,0.3)",
    borderRadius: 4,
    padding: "0.2rem 0.6rem",
    color: "inherit",
    fontWeight: active ? 700 : 400,
  };
}

// Preserve a ?viewtoken= on the "back to document" link if one is in the URL.
function tokenSuffix(): string {
  if (typeof window === "undefined") return "";
  const t = new URLSearchParams(window.location.search).get("viewtoken");
  return t ? `?viewtoken=${encodeURIComponent(t)}` : "";
}
