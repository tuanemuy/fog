import { evictAllDurableObjects, reset } from "cloudflare:test";
import { afterEach } from "vitest";

/**
 * Cleanup between integration tests.
 *
 * **Two calls, because they have different scopes**, and either one alone
 * leaves state behind:
 *
 * - `reset()` deletes the data in every binding. Durable Object SQLite is
 *   persistent storage, and nothing rolls it back for us.
 * - `evictAllDurableObjects()` destroys the instances while keeping their
 *   durable storage, which is what clears **in-memory** state — the
 *   `AlarmCache` above all. It also means the production DO classes need no
 *   test-only public method to reset it (ADR-015).
 *
 * Order matters: delete the data, then fold the instances.
 *
 * **This does not lean on an automatic rollback.** `isolatedStorage` does not
 * exist in `@cloudflare/vitest-pool-workers@0.16.20` (verified against the
 * installed package, 2026-08), so without these calls the suite goes
 * order-dependent. A future version that brings automatic rollback back would
 * make `reset()` redundant — the judgement is version-specific on purpose.
 */
afterEach(async () => {
  await reset();
  await evictAllDurableObjects();
});
