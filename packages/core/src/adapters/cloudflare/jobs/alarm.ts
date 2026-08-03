import type { DurableObjectState } from "@cloudflare/workers-types";
import type { Logger } from "@repo/core/application/ports/logger";
import { errorIdentity } from "@repo/core/lib/errorIdentity";
import { MIN_RESUME_INTERVAL_MS } from "@repo/core/lib/jobBudgets";
import type { Sql } from "../sql/exec";
import { earliestNextRunAt } from "./table";

/**
 * Alarm arming.
 *
 * Two platform facts shape everything here. First, the documented return
 * values of `setAlarm` / `getAlarm` / `deleteAlarm` contradict each other, so
 * persistence is confirmed **only** by `await ctx.storage.sync()`. Second,
 * `getAlarm()` is never called: the currently-scheduled time is cached on the
 * DO instance instead, which is also why the cache is created by the DO class
 * and passed in rather than owned here.
 */

/** The alarm time this instance believes is persisted. `null` = unknown. */
export type AlarmCache = { scheduledAt: number | null };

export function createAlarmCache(): AlarmCache {
  return { scheduledAt: null };
}

/**
 * A due job whose `next_run_at` is in the past would otherwise ask the platform
 * to fire immediately and re-enter before this wake-up has finished. Only the
 * platform alarm is clamped — `jobs.next_run_at` keeps its real value.
 */
function clamp(now: number, at: number): number {
  return at <= now ? now + 1000 : at;
}

async function persist(
  ctx: DurableObjectState,
  cache: AlarmCache,
  at: number,
): Promise<void> {
  if (cache.scheduledAt === at) return;
  await ctx.storage.setAlarm(at);
  // `sync()` failing must fail the caller: silently continuing would leave a
  // job queued with no wake-up to run it.
  await ctx.storage.sync();
  cache.scheduledAt = at;
}

/**
 * Called at the very top of `alarm()`, **before any work**. If this wake-up is
 * evicted for exceeding its CPU budget the isolate dies without running any
 * `finally`, so the re-arm has to already be persisted by then.
 */
export async function rearmBeforeWork(
  ctx: DurableObjectState,
  cache: AlarmCache,
  now: number,
): Promise<void> {
  await persist(ctx, cache, now + MIN_RESUME_INTERVAL_MS);
}

/**
 * Called after the runner finishes. An empty runnable set means the DO can go
 * fully dormant, which is the only way to stop paying one write per wake-up
 * forever. (A fail-closed DO must not reach here — it re-arms and returns.)
 */
export async function settleAlarm(
  ctx: DurableObjectState,
  sql: Sql,
  now: number,
  cache: AlarmCache,
): Promise<void> {
  const earliest = earliestNextRunAt(sql);
  if (earliest === null) {
    await ctx.storage.deleteAlarm();
    await ctx.storage.sync();
    cache.scheduledAt = null;
    return;
  }
  await persist(ctx, cache, clamp(now, earliest));
}

/**
 * Called from every RPC entry — including entries that never opened a unit of
 * work, and **on both the success and the failure path**. A transaction can
 * commit and a later statement still throw (the gate's `enqueue`,
 * `reserveCredential`'s `sweep-reservations`), and a job queued by that
 * committed transaction would otherwise wait for the next unrelated RPC.
 *
 * Issued straight after `run()` returns with no `await` in between, so nothing
 * can interleave between the commit and the arming decision.
 */
export async function armAfterRpc(
  ctx: DurableObjectState,
  sql: Sql,
  now: number,
  cache: AlarmCache,
): Promise<void> {
  const earliest = earliestNextRunAt(sql);
  if (earliest === null) return;
  await persist(ctx, cache, clamp(now, earliest));
}

/** The fixed re-arm a fail-closed DO uses. No backoff is applied. */
export async function rearmFailClosed(
  ctx: DurableObjectState,
  cache: AlarmCache,
  now: number,
): Promise<void> {
  await persist(ctx, cache, now + MIN_RESUME_INTERVAL_MS);
}

/**
 * The terminus of `alarm()`'s single broad catch, shared by both DO classes.
 *
 * **Nothing may escape `alarm()`** — a throw there is handed to the platform,
 * which is the one place the design refuses to delegate retry to. Four things
 * can fail outside any per-job guard: the pre-work re-arm, the migration gate,
 * the runner's own `listRunnable` / `claimJob` / `pruneCompleted`, and the
 * settle. None of them is caused by one job's data, so none of them belongs in
 * a `poison` row; all four end the same way a fail-closed schema does, waking
 * again at a fixed interval without deleting the alarm.
 *
 * That is not hypothetical. A Durable Object at its 10 GB ceiling fails writes
 * while reads and deletes still succeed, so `claimJob`'s `UPDATE` raises
 * `SystemError(StorageCapacityExceeded)` — and `purge-trash`, the only
 * automatic way to free space, is behind exactly that claim.
 *
 * Logs the failure's identity only, never its message: this runs on the same
 * path as `terminal_reason` and obeys the same rule.
 */
export async function rearmAfterFailure(
  ctx: DurableObjectState,
  cache: AlarmCache,
  logger: Logger,
  now: number,
  error: unknown,
): Promise<void> {
  logger.error("alarm wake-up failed", { cause: errorIdentity(error) });
  try {
    await rearmFailClosed(ctx, cache, now);
  } catch (rearmError) {
    // Storage refused the re-arm as well. The wake-up already persisted one
    // before doing any work, so the DO is normally still scheduled; there is
    // nothing further to attempt, and throwing from here would be the escape
    // this whole function exists to prevent.
    logger.error("alarm re-arm failed", { cause: errorIdentity(rearmError) });
  }
}
