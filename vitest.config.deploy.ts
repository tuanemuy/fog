import { defineConfig } from "vitest/config";

// `pnpm test:deploy` builds every deploy stage, dry-runs its deploy and
// boots `pnpm start` (`*.deploy.test.ts`). It is its own entry point because it rewrites
// `apps/web/dist` and boots a server, neither of which belongs in
// `pnpm test:unit`.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: "deploy",
    environment: "node",
    include: ["**/*.deploy.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
    fileParallelism: false,
    hookTimeout: 600_000,
    testTimeout: 60_000,
  },
});
