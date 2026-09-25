import { defineConfig } from "vitest/config";

// Node-pool config for unit tests (domain logic, fakes, pure usecases,
// presentation helpers). Anything that needs a real Durable Object lives in
// `*.integration.test.ts` and runs through `vitest.config.integration.ts`
// (the `vitest-pool-workers` Workers pool); anything that needs a DOM
// lives in `*.dom.test.{ts,tsx}` and runs through `vitest.config.dom.ts`;
// anything that builds and dry-runs a deploy lives in `*.deploy.test.ts` and
// runs through `vitest.config.deploy.ts`.
//
// Both suffixes are excluded here rather than only the `.tsx` one: a DOM
// test with no JSX in it would otherwise be misrouted into this node
// project and fail with `document is not defined`, which points at
// nothing.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: "unit",
    globals: true,
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.direnv/**",
      "**/*.integration.test.ts",
      "**/*.dom.test.{ts,tsx}",
      "**/*.deploy.test.ts",
      "spec/**",
    ],
  },
});
