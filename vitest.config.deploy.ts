import { defineConfig } from "vitest/config";

// `pnpm test:deploy` (`*.deploy.test.ts`) builds every deploy stage,
// dry-runs its deploy, boots `pnpm start`, and runs the deploy scripts as
// processes. It is its own entry point because it rewrites
// `apps/web/dist`, boots a server and spawns processes, none of which
// belongs in `pnpm test:unit`.
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
