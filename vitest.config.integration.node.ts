import { defineConfig } from "vitest/config";

// Each fog integration test provisions an isolated local libSQL database.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    // Real password hashing is CPU-bound; bound contention across isolated DB suites.
    maxWorkers: 2,
    testTimeout: 15000,
    environment: "node",
    include: [
      "packages/core/src/adapters/fog/__tests__/**/*.integration.test.ts",
      "apps/web/app/worker/node/__tests__/**/*.integration.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
  },
});
