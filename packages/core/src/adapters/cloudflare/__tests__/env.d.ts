/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `cloudflare:test` exposes `env` as `Cloudflare.Env`, so augmenting that
// namespace is what extends the binding shape inside tests.
//
// The bindings are declared here rather than consumed from the app's
// `wrangler types` output (`worker-configuration.d.ts`): that file is a
// generated artifact of the web app and this package must typecheck on its
// own. The shapes mirror `vitest.config.integration.ts`.
export {};

declare global {
  namespace Cloudflare {
    interface Env {
      USER_DATA: DurableObjectNamespace;
      IDENTITY_DIRECTORY: DurableObjectNamespace;
      APP_URL: string;
      IDENTITY_MAIL_ENCRYPTION_KEY: string;
      IDENTITY_RESET_TOKEN_KEY: string;
    }
  }
}
