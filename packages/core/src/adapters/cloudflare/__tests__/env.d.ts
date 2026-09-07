/// <reference types="@cloudflare/vitest-pool-workers/types" />

// The bindings `vitest.config.do.ts` supplies to the Durable Object test
// project. `cloudflare:test` exposes `env` as `Cloudflare.Env`, and no
// `wrangler types` run sees that config, so they are declared here.
declare global {
  namespace Cloudflare {
    interface Env {
      USER_DATA: DurableObjectNamespace<
        import("../userDataDurableObject").UserDataDurableObject
      >;
      IDENTITY_DIRECTORY: DurableObjectNamespace<
        import("../identityDirectoryDurableObject").IdentityDirectoryDurableObject
      >;
      EVENTS_QUEUE: Queue;
      PROVIDER_IDEMPOTENCY_KEY: string;
      IDENTITY_MAIL_ENCRYPTION_KEY: string;
    }
  }
}

export {};
