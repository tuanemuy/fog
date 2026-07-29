import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Integration tests run inside a Workers isolate (Miniflare) with a
// real `env.DB` D1 binding backed by an in-memory SQLite database.
// Pure unit tests run via the Node-pool `vitest.config.ts` instead,
// which excludes the `*.integration.test.ts` suffix.
//
// `include` below is an explicit allow-list of directories, not a bare
// suffix match: a `*.integration.test.ts` placed outside them is
// dropped from the unit suite by its suffix and never picked up here,
// so it silently runs in neither suite. Add the directory to `include`
// when you start putting integration tests in a new one.
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
        bindings: {
          MIGRATIONS: migrations,
          APP_URL: "http://localhost:8787",
        },
      },
    }),
  ],
  test: {
    // Allow-list — see the note at the top of this file.
    include: [
      "apps/web/app/worker/cloudflare/**/*.integration.test.ts",
      // Matches nothing today; listed so the first integration test for a
      // Cloudflare-binding adapter (e.g. `ServiceBindingRelayTrigger`) runs
      // instead of silently landing in neither suite.
      "packages/core/src/adapters/cloudflare/**/*.integration.test.ts",
      "packages/core/src/adapters/d1/**/*.integration.test.ts",
      "packages/core/src/application/**/*.integration.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
    setupFiles: ["packages/core/src/adapters/d1/__tests__/setup.ts"],
  },
});
