import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Plain route-handler-first app. Keep server-only deps (pg) external so
  // Next's bundler does not try to inline native bits.
  serverExternalPackages: ["pg"],
  // Fallback mapping in case the dot-directory route handlers misbehave in any
  // environment (see authmd-implementation.md §2). The dot-directory is the
  // primary path; this rewrite is a belt-and-suspenders alias.
  async rewrites() {
    return [
      { source: "/.well-known/:path*", destination: "/well-known/:path*" },
    ];
  },
};

export default nextConfig;
