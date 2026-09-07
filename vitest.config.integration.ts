import { defineConfig } from "vitest/config";

// Integration tests run inside a Workers isolate (Miniflare) and split
// into two projects, because `@cloudflare/vitest-pool-workers` configures
// `main` and `durableObjects` **per pool** — that is, per project.
//
// The D1 project's `setupFiles` applies the D1 migrations and truncates
// `users` before every test; running that against the Durable Object
// suites would be both pointless and coupling. Branching inside a shared
// setup file would work, but splitting the projects says the same thing
// without a conditional.
export default defineConfig({
  test: {
    projects: ["vitest.config.d1.ts", "vitest.config.do.ts"],
  },
});
