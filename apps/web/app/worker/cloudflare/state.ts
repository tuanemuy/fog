import { IdentityDirectoryDurableObject } from "@repo/core/adapters/cloudflare/identityDirectoryDurableObject";
import { UserDataDurableObject } from "@repo/core/adapters/cloudflare/userDataDurableObject";

/**
 * Entry point of the **state Worker** — the Worker that owns the Durable
 * Object classes.
 *
 * The classes themselves live in the adapter layer of `@repo/core`
 * because they are Cloudflare-specific; this module only re-exports them
 * so the runtime can find them by name, which is what
 * `[[migrations]] new_sqlite_classes` in `wrangler.state.toml` names.
 *
 * **The Outbox relay has no entry point of its own.** It runs inside each
 * Durable Object's `alarm()`, ahead of the local-job pass, on this side.
 *
 * The `fetch` handler answers 404 unconditionally and routes nothing:
 * this Worker is reached only through the Durable Object namespace
 * bindings the request Worker holds.
 */
export { IdentityDirectoryDurableObject, UserDataDurableObject };

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
