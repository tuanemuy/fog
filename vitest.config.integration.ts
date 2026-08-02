import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Integration tests run inside a Workers isolate (Miniflare) against the two
// SQLite-backed Durable Object namespaces. Pure unit tests run via the
// Node-pool `vitest.config.ts` instead, which excludes the
// `*.integration.test.ts` suffix.
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
        d1Databases: ["DB"],
        queueProducers: {
          EVENTS_QUEUE: "tanstack-start-template-events",
          // Registered so `createMessageBatch("…-events-dlq", …)` is
          // recognised by the test harness when exercising the DLQ
          // consumer; the production DLQ Worker does not bind it as a
          // producer.
          EVENTS_DLQ: "tanstack-start-template-events-dlq",
        },
        // Mirror wrangler.toml so the DLQ routing wiring is the same
        // shape miniflare sees in production. Tests that go through
        // `createMessageBatch(...)` bypass dispatch and don't depend on
        // these values, but registering them keeps the per-batch
        // disposition (`retryBatch.retry`) consistent with how real
        // queues would surface the same handler decision, and prevents
        // silent drift when wrangler.toml is tuned.
        queueConsumers: {
          "tanstack-start-template-events": {
            maxBatchSize: 25,
            maxBatchTimeout: 30,
            maxRetries: 3,
            deadLetterQueue: "tanstack-start-template-events-dlq",
          },
          "tanstack-start-template-events-dlq": {
            maxBatchSize: 25,
            maxBatchTimeout: 30,
            maxRetries: 1,
          },
        },
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
        },
      },
    }),
  ],
  test: {
    // Allow-list — see the note at the top of this file.
    include: [
      "apps/web/app/durable-objects/**/*.integration.test.ts",
      "apps/web/app/worker/cloudflare/**/*.integration.test.ts",
      // Matches nothing today; listed so the first integration test for a
      // Cloudflare-binding adapter (e.g. `ServiceBindingRelayTrigger`) runs
      // instead of silently landing in neither suite.
      "packages/core/src/adapters/cloudflare/**/*.integration.test.ts",
      "packages/core/src/adapters/d1/**/*.integration.test.ts",
      "packages/core/src/application/**/*.integration.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
    setupFiles: ["packages/core/src/adapters/cloudflare/__tests__/setup.ts"],
  },
});
