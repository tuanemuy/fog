import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Durable Object integration project.
//
// `main` points at a test entry that re-exports both Durable Object
// classes, so `runInDurableObject` hands back the same instances the
// bindings address.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    cloudflareTest({
      main: "packages/core/src/adapters/cloudflare/__tests__/testWorker.ts",
      miniflare: {
        compatibilityDate: "2026-05-01",
        compatibilityFlags: ["nodejs_compat"],
        // `useSQLite` mirrors `new_sqlite_classes` in
        // `wrangler.state.toml`. Without it the classes get the key-value
        // backend and `ctx.storage.sql` is unavailable.
        durableObjects: {
          USER_DATA: {
            className: "UserDataDurableObject",
            useSQLite: true,
          },
          IDENTITY_DIRECTORY: {
            className: "IdentityDirectoryDurableObject",
            useSQLite: true,
          },
        },
        queueProducers: {
          EVENTS_QUEUE: "tanstack-start-template-events",
        },
        // Mirrors the request Worker's config so the disposition of a
        // batch in tests matches what real queues would produce.
        //
        // The values are literals rather than reads of
        // `DELIVERY_TUNING_DEFAULTS`: Vitest loads this config through
        // Node's strip-only TypeScript support, which rejects the
        // parameter properties `CodedError` uses, so importing the
        // tuning module here fails to load at all. `wranglerConfig.test.ts`
        // parses this block instead and pins every value below against
        // the declared tuning and the wrangler config.
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
          // Both are state-Worker secrets; the tests need a value, not
          // the real one. The encryption key is held to the keyring's
          // declared floor, because the keyring refuses a shorter one.
          PROVIDER_IDEMPOTENCY_KEY: "test-provider-idempotency-key-at-least-32",
          IDENTITY_RESET_TOKEN_KEY: "test-reset-token-key-at-least-32-chars",
          IDENTITY_MAIL_ENCRYPTION_KEY:
            "test-identity-mail-encryption-key-0123456789",
        },
      },
    }),
  ],
  test: {
    name: "durable-objects",
    include: [
      "packages/core/src/adapters/cloudflare/**/*.integration.test.ts",
      // The identity usecases run against the Durable Objects, so their
      // integration suites belong to this pool and not to the D1 one. A
      // directory neither config names runs in no pool at all and reports
      // nothing.
      "packages/core/src/application/**/*.integration.test.ts",
      "apps/web/app/worker/cloudflare/**/*.integration.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
  },
});
