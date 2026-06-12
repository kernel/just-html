import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Plain route-handler-first app. Keep server-only deps (pg) external so
  // Next's bundler does not try to inline native bits.
  serverExternalPackages: ["pg"],
  // Discovery docs are served by real route handlers under app/.well-known/*
  // (authmd-implementation.md §2). The B1 reviewer found that the previous
  // afterFiles rewrite of /.well-known/* -> /well-known/* was dead code: an
  // afterFiles rewrite only fires AFTER the filesystem/route match, so the
  // app/[...path] catch-all 404 won that race. The dot-directory handlers are
  // verified to build and serve, so no rewrite is needed (or wanted).
};

export default nextConfig;
