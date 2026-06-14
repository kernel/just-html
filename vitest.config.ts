import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test-only config. Mirrors the `@/*` -> repo-root path alias from tsconfig so
// unit tests can import modules the same way app code does. Does not affect the
// Next.js build or runtime.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
