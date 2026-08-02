import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Integration tests run inside a Workers isolate (Miniflare) against the two
// SQLite-backed Durable Object namespaces — the only storage this system has.
// Pure unit tests run via the Node-pool `vitest.config.ts` instead, which
// excludes the `*.integration.test.ts` suffix; the boot smoke tests are a third
// suite again (`vitest.config.smoke.ts`), because they start a *built* Worker
// rather than importing modules into this isolate.
//
// `include` below is an explicit allow-list of directories, not a bare
// suffix match: a `*.integration.test.ts` placed outside them is
// dropped from the unit suite by its suffix and never picked up here,
// so it silently runs in neither suite. Add the directory to `include`
// when you start putting integration tests in a new one.

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    // Written inline at the argument position on purpose: `WorkersPoolOptions`
    // is not exported as a type, so hoisting this object into a variable would
    // silently turn off type checking for it.
    cloudflareTest({
      // `main` is a **top-level** `WorkersPoolOptions` field, not a miniflare
      // one. `miniflare` accepts `SourcelessWorkerOptions`, which has no
      // `main`, and its schema is `passthrough` — so writing it there is
      // dropped at runtime without a word, and DO bindings that omit
      // `scriptName` then fail to resolve. Pointing it at the state Worker is
      // what lets the bindings below bind its exported classes directly.
      main: "apps/web/app/worker/cloudflare/state.ts",
      miniflare: {
        compatibilityDate: "2026-05-01",
        compatibilityFlags: ["nodejs_compat"],
        // `useSQLite: true` is **mandatory**, and the object form is required
        // because of it: the string shorthand (`USER_DATA:
        // "UserDataDurableObject"`) cannot express it. The default backend is
        // KV, where `ctx.storage.sql` does not exist, so dropping this one
        // line makes every DO SQLite test in the repository fail. Production
        // is protected by the wrangler config's `storage = "sqlite"`, but that
        // is a different mechanism and does not cover the test environment.
        durableObjects: {
          USER_DATA: { className: "UserDataDurableObject", useSQLite: true },
          IDENTITY_DIRECTORY: {
            className: "IdentityDirectoryDurableObject",
            useSQLite: true,
          },
        },
        bindings: {
          APP_URL: "http://localhost:8787",
          // The state Worker's two keyrings. Test values, and the only reason
          // they are here at all is that `send-mail` derives the reset link and
          // opens the stored address with them — an unbound keyring makes that
          // job fail loudly rather than silently drop the mail, which is the
          // behaviour the suite asserts.
          IDENTITY_MAIL_ENCRYPTION_KEY: JSON.stringify([
            { generation: 1, key: "test-mail-encryption-key-0123456789" },
          ]),
          IDENTITY_RESET_TOKEN_KEY: JSON.stringify([
            { generation: 1, key: "test-reset-token-key-0123456789ab" },
          ]),
        },
      },
    }),
  ],
  test: {
    // Allow-list — see the note at the top of this file.
    include: [
      "packages/core/src/adapters/cloudflare/**/*.integration.test.ts",
      "packages/core/src/application/**/*.integration.test.ts",
      "apps/web/app/durable-objects/**/*.integration.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
    setupFiles: ["packages/core/src/adapters/cloudflare/__tests__/setup.ts"],
  },
});
