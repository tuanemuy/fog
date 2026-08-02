import { IdentityDirectoryDurableObject } from "../../durable-objects/identityDirectory";
import { UserDataDurableObject } from "../../durable-objects/userData";

/**
 * Entry point of the state Worker — the Worker that owns the Durable Object
 * classes. It has **no public routes**: the only way in is a binding-backed
 * RPC call from the request Worker, so the default fetch handler answers 404
 * unconditionally.
 *
 * The two exports below are what the wrangler config's `exports` declaration
 * turns into SQLite-backed DO namespaces at deploy time.
 */
export { IdentityDirectoryDurableObject, UserDataDurableObject };

export default {
  fetch: () => new Response("not found", { status: 404 }),
};
