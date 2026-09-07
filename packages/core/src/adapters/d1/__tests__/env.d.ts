/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "cloudflare:test";

// `cloudflare:test` exposes `env` as `Cloudflare.Env`, so augmenting
// that namespace is what extends the binding shape inside tests.
//
// The bindings are declared here rather than consumed from the app's
// `wrangler types` output (`worker-configuration.d.ts`): that file is a
// generated artifact of the web app and this package must typecheck on
// its own. The shapes mirror the miniflare bindings of the two
// integration projects (`vitest.config.d1.ts` / `vitest.config.do.ts`).
// `MIGRATIONS` in particular is injected via `miniflare.bindings`, not
// by `wrangler.toml`, so it never lands in generated types anywhere.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      APP_URL: string;
      MIGRATIONS: D1Migration[];
      USER_DATA: DurableObjectNamespace<
        import("../../cloudflare/userDataDurableObject").UserDataDurableObject
      >;
      IDENTITY_DIRECTORY: DurableObjectNamespace<
        import("../../cloudflare/identityDirectoryDurableObject").IdentityDirectoryDurableObject
      >;
      EVENTS_QUEUE: Queue;
      PROVIDER_IDEMPOTENCY_KEY: string;
    }
  }
}
