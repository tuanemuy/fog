import { env, runInDurableObject } from "cloudflare:test";
import type { SqlStorage } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { enqueueJob } from "../jobs/table";

/**
 * The one suite that depends on `setup.ts`'s `afterEach`.
 *
 * Every other integration file derives a **fresh Durable Object name** per
 * test from a module-scope counter, so removing either cleanup call leaves them
 * all green — measured. That is a fine first line of defence, and it is also
 * why the cleanup had no test: nothing observed it.
 *
 * The two cases below are deliberately **identical** and share one fixed name.
 * Whichever runs second can only pass if, between them:
 *
 * - `reset()` deleted the durable data — otherwise the `jobs` table still holds
 *   the previous case's row and the first assertion fails;
 * - `evictAllDurableObjects()` destroyed the instance — otherwise the surviving
 *   `AlarmCache` still reads `ARMED_AT`, `persist()` skips the `setAlarm` as
 *   redundant, and the alarm the reset just cleared is never re-armed.
 *
 * Being identical is what makes the pair independent of execution order, which
 * matters because the suite is also run under `--sequence.shuffle`.
 *
 * `gate.integration.test.ts` already uses fixed names (`gate-ud-tables` and
 * friends), so this is not a hypothetical style — it is the style that was
 * already relying on a cleanup nothing checked.
 */

// Far enough ahead that the platform never delivers it during the run, and a
// constant rather than a `Date.now()` offset so that both cases compute the
// same value — the cache-skip above is only observable if they do.
const ARMED_AT = 4_000_000_000_000;

const NAME = "cleanup-fixed-name";

type Entry = {
  getCurrentUser(userId: string, epoch: number): Promise<unknown>;
};

function stub() {
  const ns = env.USER_DATA;
  return ns.get(ns.idFromName(NAME));
}

/** Any gated RPC entry will do: all of them arm the alarm on the way out. */
function touch(instance: ReturnType<typeof stub>): Promise<unknown> {
  return (instance as unknown as Entry).getCurrentUser("no-such-user", 0);
}

async function exerciseFixedName(): Promise<{
  queuedOnArrival: string[];
  armed: number | null;
}> {
  const instance = stub();
  // Creates the schema if this Durable Object has none — which is itself part
  // of what `reset()` throws away.
  await touch(instance);

  const queuedOnArrival = (await runInDurableObject(instance, (_i, ctx) =>
    (ctx.storage.sql as SqlStorage)
      .exec<{ operation_key: string }>("SELECT operation_key FROM jobs")
      .toArray()
      .map((row) => row.operation_key),
  )) as string[];

  await runInDurableObject(instance, (_i, ctx) => {
    enqueueJob(ctx.storage.sql as SqlStorage, 0, {
      kind: "purge-trash",
      operationKey: "purge-trash",
      payload: {},
      nextRunAt: ARMED_AT,
    });
  });
  await touch(instance);

  const armed = (await runInDurableObject(instance, (_i, ctx) =>
    ctx.storage.getAlarm(),
  )) as number | null;
  return { queuedOnArrival, armed };
}

describe("cleanup between tests, under a fixed Durable Object name", () => {
  it("finds an empty Durable Object and arms it (1 of 2)", async () => {
    const result = await exerciseFixedName();
    expect(result.queuedOnArrival).toEqual([]);
    expect(result.armed).toBe(ARMED_AT);
  });

  it("finds an empty Durable Object and arms it (2 of 2)", async () => {
    const result = await exerciseFixedName();
    expect(result.queuedOnArrival).toEqual([]);
    expect(result.armed).toBe(ARMED_AT);
  });
});
