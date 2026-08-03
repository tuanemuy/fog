import { evictAllDurableObjects, reset } from "cloudflare:test";
import { afterEach } from "vitest";

/**
 * Cleanup between integration tests.
 *
 * **The first line of defence is not here.** Nearly every suite derives a fresh
 * Durable Object name per test from a module-scope counter, and a fresh name is
 * a fresh Durable Object — so those files are order-independent whatever this
 * hook does. What this hook covers is the files that use a **fixed** name
 * (`schema/__tests__/gate.integration.test.ts`, and `cleanup.integration.test.ts`,
 * which exists to observe exactly that).
 *
 * - `reset()` deletes the data in every binding, which is what a fixed-name
 *   test needs: Durable Object SQLite is persistent storage and nothing rolls
 *   it back for us. Removing this line turns `cleanup.integration.test.ts` red
 *   (measured).
 * - `evictAllDurableObjects()` is intended to destroy the instances while
 *   keeping their durable storage, which is what would clear **in-memory**
 *   state — the `AlarmCache` above all — without giving the production DO
 *   classes a test-only reset method. **Measured, it is currently
 *   redundant**: after `reset()` alone, a Durable Object comes back with its
 *   alarm cleared *and* re-arms on the next RPC, which a surviving `AlarmCache`
 *   would have suppressed. So `reset()` is already discarding the instance in
 *   `@cloudflare/vitest-pool-workers@0.16.20`. The call is kept as insurance
 *   against that changing, not because a test depends on it — and no comment
 *   here should claim otherwise, since a redundant call that is believed to be
 *   load-bearing is how a real cleanup gap gets misdiagnosed.
 *
 * Order matters: delete the data, then fold the instances.
 *
 * **This does not lean on an automatic rollback.** `isolatedStorage` does not
 * exist in `@cloudflare/vitest-pool-workers@0.16.20` (verified against the
 * installed package). A future version that brings automatic rollback would
 * make `reset()` redundant too — the judgement is version-specific on purpose.
 */
afterEach(async () => {
  await reset();
  await evictAllDurableObjects();
});
