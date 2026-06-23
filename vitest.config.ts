import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test-only config. Mirrors the `@/*` -> repo-root path alias from tsconfig so
// unit tests can import modules the same way app code does. Does not affect the
// Next.js build or runtime.
export default defineConfig({
  // tsconfig sets jsx:"preserve" for Next; vitest 4 transforms with oxc, which needs
  // an explicit automatic-runtime setting to run the .tsx component (and its test).
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
