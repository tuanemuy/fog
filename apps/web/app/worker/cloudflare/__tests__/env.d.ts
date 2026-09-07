/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `cloudflare:test` exposes `env` as `Cloudflare.Env`, which for this app
// comes from the generated `worker-configuration.d.ts`. The Durable
// Object test project supplies bindings that `wrangler types` never sees
// (they come from `vitest.config.do.ts` rather than from a wrangler
// config), so they are declared here.
declare global {
  namespace Cloudflare {
    interface Env {
      USER_DATA: DurableObjectNamespace<
        import("@repo/core/adapters/cloudflare/userDataDurableObject").UserDataDurableObject
      >;
      IDENTITY_DIRECTORY: DurableObjectNamespace<
        import("@repo/core/adapters/cloudflare/identityDirectoryDurableObject").IdentityDirectoryDurableObject
      >;
      EVENTS_QUEUE: Queue;
      PROVIDER_IDEMPOTENCY_KEY: string;
    }
  }
}

export {};
