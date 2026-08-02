import { defineConfig } from "vitest/config";

// Node-pool config for unit tests (domain logic, fakes, property-based,
// pure usecases). Anything that needs a real Durable Object binding lives in
// `*.integration.test.ts` and runs through `vitest.config.integration.ts`
// (the `vitest-pool-workers` Workers pool); anything that starts a *built*
// Worker lives in `*.smoke.test.ts` and runs through `vitest.config.smoke.ts`.
// Both suffixes are excluded below so a test cannot land in two suites.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.direnv/**",
      "**/*.integration.test.ts",
      "**/*.smoke.test.ts",
      "spec/**",
    ],
  },
});
