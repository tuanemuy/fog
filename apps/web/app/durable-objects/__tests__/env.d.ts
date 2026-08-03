/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `cloudflare:test` exposes `env` as `Cloudflare.Env`, so augmenting that
// namespace is what extends the binding shape inside tests. Mirrors
// `vitest.config.integration.ts`, and mirrors the identical file in
// `packages/core` — the two packages typecheck independently.
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
