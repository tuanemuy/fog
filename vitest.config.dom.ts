import { defineConfig } from "vitest/config";

// jsdom project for the rendering branches of `apps/web`'s components.
//
// What it draws: `"use client"` islands, server components that are pure
// functions of their props, and `async` data-loading leaves — the last by
// `await`ing the component and rendering the element it returned. What it
// does not draw: routes, loaders, `renderServerComponent` (Flight),
// hydration and CSS. `docs/test.md` (the DOM section) is the authority on
// that boundary.
//
// `include` is an explicit allow-list rooted at `apps/web/app/`, matching
// the shape `vitest.config.d1.ts` / `vitest.config.do.ts` already use: a
// `*.dom.test.{ts,tsx}` outside that root is dropped from the unit project
// by its suffix and claimed by no project here, so it runs nowhere. Add
// the directory to this `include` in the same change that puts a test in a
// new one.
//
// `exclude` replaces Vitest's defaults wholesale (`**/cypress/**`,
// `**/.{idea,git,cache,output,temp}/**`, …) rather than extending them.
// That is harmless because `include` is a strict allow-list, and it keeps
// this project's shape identical to the unit one's.
//
// `globals: true` is here for one reason: `@testing-library/react`
// registers its automatic `afterEach` cleanup through the global hook.
// Test bodies do not rely on globals — they import from `vitest`
// explicitly, as the rest of `apps/web` does (`apps/web/tsconfig.json`
// carries no `vitest/globals` in its `types`).
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: "dom",
    globals: true,
    environment: "jsdom",
    include: ["apps/web/app/**/__tests__/*.dom.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
  },
});
