import { defineConfig } from "vitest/config";

// `pnpm test:unit` is two projects: the node pool that runs the pure
// logic suites (`vitest.config.unit.ts`) and the jsdom pool that renders
// components (`vitest.config.dom.ts`). Same shape as
// `vitest.config.integration.ts` — the root lists the projects and holds
// nothing else, because in projects mode a `test` option here reaches
// neither of them. Put per-project options in the project's own config.
export default defineConfig({
  test: {
    projects: ["vitest.config.unit.ts", "vitest.config.dom.ts"],
  },
});
