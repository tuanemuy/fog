import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// D1-backed integration project: a real `env.DB` binding over an
// in-memory SQLite database. Pure unit tests run in the Node pool via
// `vitest.config.unit.ts`, the jsdom suites via `vitest.config.dom.ts`,
// and the Durable Object suites run in the sibling project
// `vitest.config.do.ts`.
//
// `include` is an explicit allow-list of directories, not a bare suffix
// match: a `*.integration.test.ts` placed outside them is dropped from
// the unit suite by its suffix and never picked up here, so it would run
// in neither. Add the directory when you start putting tests in a new one.
const migrationsPath = path.join(
  import.meta.dirname,
  "packages/core/src/adapters/d1/migrations",
);

const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-05-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        bindings: {
          MIGRATIONS: migrations,
          APP_URL: "http://localhost:8787",
        },
      },
    }),
  ],
  test: {
    name: "d1",
    include: ["packages/core/src/adapters/d1/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
    setupFiles: ["packages/core/src/adapters/d1/__tests__/setup.ts"],
  },
});
