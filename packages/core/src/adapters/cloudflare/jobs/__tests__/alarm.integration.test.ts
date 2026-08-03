import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import { MIN_RESUME_INTERVAL_MS } from "@repo/core/lib/jobBudgets";
import { describe, expect, it } from "vitest";
import { inUserData } from "../../__tests__/doHarness";
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
