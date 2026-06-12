import type { ReactNode } from "react";

// Root layout — REQUIRED by Next.js App Router for the React page surfaces
// (currently only /d/:slug/history; the viewer shell stays a route handler for
// now). Every OTHER surface in this app is a plain route handler returning
// new Response(html), which does NOT pass through this layout — so this file does
// not add a React runtime to the man-page pages (homepage, /auth.md, /llms.txt,
// /raw, the JSON discovery docs, the form POSTs). It exists solely so the two
// designated React surfaces have a document shell. Styling is kept consistent with
// the man-page brand: monospace, light/dark via color-scheme.
export const metadata = {
  title: "justhtml.sh",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style
          dangerouslySetInnerHTML={{
            __html: `:root{color-scheme:light dark}
*{box-sizing:border-box}
html,body{margin:0}
body{font-family:ui-monospace,"SF Mono",Menlo,Consolas,"Courier New",monospace;color:#111;background:#fff}
a{color:#0000ee}
@media (prefers-color-scheme: dark){body{color:#d8d8d8;background:#0d0d0d}a{color:#6cb6ff}}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
