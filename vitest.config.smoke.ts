import { defineConfig } from "vitest/config";

// Boot smoke tests: a **third** suite, and deliberately not part of the Workers
// pool one.
//
// `.adr/001` settles on a single Workers-pool project, but that decision is
// about integration tests — code imported into an isolate the pool sets up. The
// question here is different and cannot be asked from inside such an isolate:
// does the *bundle* `pnpm build:cf` produced start under workerd at all? So
// these run in the Node pool and drive Miniflare directly, pointing it at
// `dist/` with `scriptPath`.
//
// It exists because nothing else catches a module-scope `crypto.randomUUID()`:
// it type-checks, lints and passes every integration test, and fails only when
// workerd evaluates the top-level module.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["apps/web/__tests__/**/*.smoke.test.ts"],
    exclude: ["**/node_modules/**", "**/.direnv/**"],
    // Starting two workerd instances is slower than an import.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
