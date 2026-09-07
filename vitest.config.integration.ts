import { defineConfig } from "vitest/config";

// Integration tests run inside a Workers isolate (Miniflare). The pool
// configuration (`main`, `durableObjects`, queues) lives in
// `vitest.config.do.ts`; this file only lists the projects so that
// `pnpm test:integration` has one entry point.
export default defineConfig({
  test: {
    projects: ["vitest.config.do.ts"],
  },
});
