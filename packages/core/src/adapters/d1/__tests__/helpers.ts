import { env } from "cloudflare:test";
import { type Database, getDatabase } from "../client";

/**
 * A Drizzle handle over the test isolate's `env.DB` binding.
 *
 * The binding is a singleton per Workers isolate but row cleanup is driven
 * by the file-level `setup.ts` (TRUNCATE in `beforeEach`), so each test
 * sees a clean database.
 *
 * **No container is built here any more.** The request container carries
 * no D1 handle since the identity usecases moved into the Durable Objects;
 * what is left in this pool tests the driver-error classification against
 * a real binding, and that needs the handle and nothing else.
 */
export function createTestDatabase(): Database {
  return getDatabase(env.DB);
}
