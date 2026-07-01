import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// D1-backend tests run inside workerd (miniflare) with a local D1 bound as `DB`.
// Scoped to *.spec.ts so the node:test suite (*.test.ts, run via `bun test`)
// stays untouched and each runner owns its own files.
export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
  },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-06-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { DB: "mimir-test" },
      },
    }),
  ],
});
