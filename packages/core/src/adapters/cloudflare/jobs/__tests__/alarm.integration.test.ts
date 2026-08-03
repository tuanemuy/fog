import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import { MIN_RESUME_INTERVAL_MS } from "@repo/core/lib/jobBudgets";
import { describe, expect, it } from "vitest";
import { inUserData } from "../../__tests__/doHarness";
import { runRpcEntry } from "../../platform/rpcEntry";
import { runMigrationGate } from "../../schema/gate";
import { USER_DATA_CODE_VERSION, USER_DATA_STEPS } from "../../schema/userData";
import {
  armAfterRpc,
  createAlarmCache,
  rearmBeforeWork,
  rearmFailClosed,
  settleAlarm,
} from "../alarm";
import { claimJob, completeJob, enqueueJob } from "../table";

// All times are offsets from a base that is safely in the **future**:
// workerd stores an alarm set in the past as "now", so absolute test constants
// like 1000 would come back as the wall clock and assert nothing.
const BASE = Date.now() + 3_600_000;

// Arming is asserted through `ctx.storage.getAlarm()` *after* the helpers have
// already confirmed persistence with `sync()`. The helpers themselves never
// call `getAlarm()` — its documented return value is inconsistent, which is
// the whole reason the scheduled time is cached on the instance.

let seq = 0;
function harness<T>(
  fn: (io: { sql: SqlStorage; ctx: DurableObjectState }) => Promise<T>,
): Promise<T> {
  seq += 1;
  const name = `alarm-${seq}`;
  return inUserData(name, ({ ctx, sql }) => {
    runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, name);
    return fn({ ctx, sql });
  }) as Promise<T>;
}

describe("alarm arming", () => {
  it("re-arms before doing any work", async () => {
    const at = await harness(async ({ ctx }) => {
      const cache = createAlarmCache();
      await rearmBeforeWork(ctx, cache, BASE + 1_000);
      return ctx.storage.getAlarm();
    });
    expect(at).toBe(BASE + 1_000 + MIN_RESUME_INTERVAL_MS);
  });

  it("keeps the pre-work re-arm even if the work then fails", async () => {
    const at = await harness(async ({ ctx }) => {
      const cache = createAlarmCache();
      await rearmBeforeWork(ctx, cache, BASE + 1_000);
      try {
        throw new Error("work blew up");
      } catch {
        // The alarm was already persisted before this point, which is the
        // whole reason the re-arm is not in a `finally`: a CPU eviction kills
        // the isolate outright and no `finally` would run.
      }
      return ctx.storage.getAlarm();
    });
    expect(at).toBe(BASE + 1_000 + MIN_RESUME_INTERVAL_MS);
  });

  it("settles to the earliest runnable next_run_at", async () => {
    const at = await harness(async ({ ctx, sql }) => {
      const cache = createAlarmCache();
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey: "a",
        payload: {},
        nextRunAt: BASE + 90_000,
      });
      enqueueJob(sql, 0, {
        kind: "send-mail",
        operationKey: "b",
        payload: {},
        nextRunAt: BASE + 40_000,
      });
      await settleAlarm(ctx, sql, BASE + 1_000, cache);
      return ctx.storage.getAlarm();
    });
    expect(at).toBe(BASE + 40_000);
  });

  it("deletes the alarm when the runnable set is empty", async () => {
    const result = await harness(async ({ ctx, sql }) => {
      const cache = createAlarmCache();
      enqueueJob(sql, 0, {
        kind: "send-mail",
        operationKey: "b",
        payload: {},
        nextRunAt: BASE + 40_000,
      });
      await settleAlarm(ctx, sql, BASE + 1_000, cache);
      const armed = await ctx.storage.getAlarm();
      claimJob(sql, "b", BASE + 40_000, "owner-1", 60_000);
      completeJob(sql, "b", "owner-1", BASE + 40_000, null);
      await settleAlarm(ctx, sql, BASE + 41_000, cache);
      return { armed, cleared: await ctx.storage.getAlarm(), cache };
    });
    expect(result.armed).toBe(BASE + 40_000);
    expect(result.cleared).toBeNull();
    expect(result.cache.scheduledAt).toBeNull();
  });

  it("clamps a past-due job forward instead of firing re-entrantly", async () => {
    const at = await harness(async ({ ctx, sql }) => {
      const cache = createAlarmCache();
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey: "a",
        payload: {},
        nextRunAt: BASE + 500,
      });
      await settleAlarm(ctx, sql, BASE + 10_000, cache);
      const armed = await ctx.storage.getAlarm();
      // The DB keeps the real time; only the platform alarm is clamped.
      const stored = sql
        .exec<{ next_run_at: number }>(
          "SELECT next_run_at FROM jobs WHERE operation_key='a'",
        )
        .one().next_run_at;
      return { armed, stored };
    });
    expect(at.armed).toBe(BASE + 11_000);
    expect(at.stored).toBe(BASE + 500);
  });

  it("arms from an RPC entry, including when the entry opened no unit of work", async () => {
    const at = await harness(async ({ ctx, sql }) => {
      const cache = createAlarmCache();
      enqueueJob(sql, 0, {
        kind: "send-mail",
        operationKey: "b",
        payload: {},
        nextRunAt: BASE + 40_000,
      });
      await armAfterRpc(ctx, sql, BASE + 1_000, cache);
      return ctx.storage.getAlarm();
    });
    expect(at).toBe(BASE + 40_000);
  });

  it("leaves the alarm alone from an RPC entry when nothing is queued", async () => {
    const at = await harness(async ({ ctx, sql }) => {
      const cache = createAlarmCache();
      await armAfterRpc(ctx, sql, BASE + 1_000, cache);
      return ctx.storage.getAlarm();
    });
    expect(at).toBeNull();
  });

  it("never pushes an existing arm later from an RPC entry", async () => {
    const result = await harness(async ({ ctx, sql }) => {
      const cache = createAlarmCache();
      // Due already, so every call clamps to `its own now + 1000` — the shape a
      // bucket taking more than one RPC per second is in.
      enqueueJob(sql, 0, {
        kind: "send-mail",
        operationKey: "b",
        payload: {},
        nextRunAt: BASE + 500,
      });
      const writes: number[] = [];
      const real = ctx.storage.setAlarm.bind(ctx.storage);
      ctx.storage.setAlarm = (at: number | Date) => {
        writes.push(typeof at === "number" ? at : at.getTime());
        return real(at);
      };
      try {
        await armAfterRpc(ctx, sql, BASE + 1_000, cache);
        await armAfterRpc(ctx, sql, BASE + 1_500, cache);
        await armAfterRpc(ctx, sql, BASE + 1_900, cache);
        return {
          writes: [...writes],
          armed: await ctx.storage.getAlarm(),
          cached: cache.scheduledAt,
        };
      } finally {
        ctx.storage.setAlarm = real;
      }
    });
    // The second and third calls would each have written `now + 1000`, which is
    // later than what is already armed: the due row would then never come up.
    expect(result.writes).toEqual([BASE + 2_000]);
    expect(result.armed).toBe(BASE + 2_000);
    expect(result.cached).toBe(BASE + 2_000);
  });

  it("re-arms a fail-closed DO at a fixed interval without deleting the alarm", async () => {
    const result = await harness(async ({ ctx }) => {
      const cache = createAlarmCache();
      await rearmFailClosed(ctx, cache, BASE + 1_000);
      const first = await ctx.storage.getAlarm();
      await rearmFailClosed(ctx, cache, BASE + 1_000 + MIN_RESUME_INTERVAL_MS);
      return { first, second: await ctx.storage.getAlarm() };
    });
    expect(result.first).toBe(BASE + 1_000 + MIN_RESUME_INTERVAL_MS);
    expect(result.second).toBe(BASE + 1_000 + 2 * MIN_RESUME_INTERVAL_MS);
  });

  it("skips the write when the cached time already matches", async () => {
    const result = await harness(async ({ ctx, sql }) => {
      const cache = createAlarmCache();
      enqueueJob(sql, 0, {
        kind: "send-mail",
        operationKey: "b",
        payload: {},
        nextRunAt: BASE + 40_000,
      });
      // The claim is that the *write* is skipped, so the write is what gets
      // counted. Reading the cache back would leave "arms every time" green,
      // since arming again stores the same value.
      const writes: number[] = [];
      const real = ctx.storage.setAlarm.bind(ctx.storage);
      ctx.storage.setAlarm = (at: number | Date) => {
        writes.push(typeof at === "number" ? at : at.getTime());
        return real(at);
      };
      try {
        await armAfterRpc(ctx, sql, BASE + 1_000, cache);
        const afterFirst = writes.length;
        await armAfterRpc(ctx, sql, BASE + 1_000, cache);
        // A different earliest time is a real change and must still be written,
        // so the counter is not simply "at most one write ever".
        enqueueJob(sql, 0, {
          kind: "purge-trash",
          operationKey: "a",
          payload: {},
          nextRunAt: BASE + 20_000,
        });
        await armAfterRpc(ctx, sql, BASE + 1_000, cache);
        return { afterFirst, writes: [...writes], cached: cache.scheduledAt };
      } finally {
        ctx.storage.setAlarm = real;
      }
    });
    expect(result.afterFirst).toBe(1);
    expect(result.writes).toEqual([BASE + 40_000, BASE + 20_000]);
    expect(result.cached).toBe(BASE + 20_000);
  });
});

/**
 * The wrapper every RPC entry goes through, driven directly.
 *
 * The cases above call `armAfterRpc` themselves, which is the right granularity
 * for the arming rules but skips the two decisions `runRpcEntry` owns: that the
 * arm happens **after a body that threw** — AC-12 (iii)'s "on both paths" — and
 * that an arm which cannot be persisted turns a successful body into an `err`.
 * Move the `armAfterRpc` call inside the `try` block and nothing else in this
 * repository notices; the first case below does.
 */
describe("the RPC entry wrapper", () => {
  const nothing = () => undefined;

  it("arms the alarm even when the body throws after committing", async () => {
    const result = await harness(async ({ ctx, sql }) => {
      const cache = createAlarmCache();
      const envelope = await runRpcEntry(
        { ctx, sql, cache, gate: nothing },
        BASE + 1_000,
        () => {
          // The failure mode the design names: a transaction commits and a
          // later statement in the same entry still throws. The row is real, so
          // the wake-up it needs has to be armed anyway.
          enqueueJob(sql, 0, {
            kind: "send-mail",
            operationKey: "b",
            payload: {},
            nextRunAt: BASE + 40_000,
          });
          throw new Error("a later statement blew up");
        },
      );
      return { envelope, armed: await ctx.storage.getAlarm() };
    });
    expect(result.envelope.ok).toBe(false);
    expect(result.armed).toBe(BASE + 40_000);
  });

  it("arms the alarm when the gate refuses before the body runs", async () => {
    const result = await harness(async ({ ctx, sql }) => {
      const cache = createAlarmCache();
      // A job left behind by an earlier, successful call. A fail-closed entry
      // must not strand it, which is why the gate's throw lands in the same
      // `catch` as the body's.
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey: "a",
        payload: {},
        nextRunAt: BASE + 90_000,
      });
      let bodyRan = false;
      const envelope = await runRpcEntry(
        {
          ctx,
          sql,
          cache,
          gate: () => {
            throw new Error("Schema version is newer than this deployment");
          },
        },
        BASE + 1_000,
        () => {
          bodyRan = true;
          return null;
        },
      );
      return { envelope, bodyRan, armed: await ctx.storage.getAlarm() };
    });
    expect(result.envelope.ok).toBe(false);
    expect(result.bodyRan).toBe(false);
    expect(result.armed).toBe(BASE + 90_000);
  });

  it("reports an arm it could not persist as a failed call", async () => {
    const result = await harness(async ({ ctx, sql }) => {
      const cache = createAlarmCache();
      enqueueJob(sql, 0, {
        kind: "send-mail",
        operationKey: "b",
        payload: {},
        nextRunAt: BASE + 40_000,
      });
      const real = ctx.storage.setAlarm.bind(ctx.storage);
      ctx.storage.setAlarm = () => {
        throw new Error("storage refused the alarm");
      };
      try {
        const envelope = await runRpcEntry(
          { ctx, sql, cache, gate: nothing },
          BASE + 1_000,
          () => "the body's own answer",
        );
        return { envelope, cached: cache.scheduledAt };
      } finally {
        ctx.storage.setAlarm = real;
      }
    });
    // The body succeeded and its value is discarded on purpose: answering `ok`
    // would tell the caller its work is scheduled when no wake-up exists to run
    // it.
    expect(result.envelope.ok).toBe(false);
    // …and nothing was cached, so the next entry retries the write rather than
    // skipping it as redundant.
    expect(result.cached).toBeNull();
  });

  it("answers a successful body with its value", async () => {
    // Positive control for the three refusals above: the same wrapper, the same
    // harness, and an entry that queued nothing still comes back `ok`.
    const envelope = await harness(({ ctx, sql }) =>
      runRpcEntry(
        { ctx, sql, cache: createAlarmCache(), gate: nothing },
        BASE + 1_000,
        () => "the body's own answer",
      ),
    );
    expect(envelope.ok).toBe(true);
    expect(envelope.ok && envelope.value).toBe("the body's own answer");
  });
});
