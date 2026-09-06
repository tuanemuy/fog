import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-04",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    globals: true,
    testTimeout: 30_000,
    include: ["**/*.cloudflare.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
  },
});
