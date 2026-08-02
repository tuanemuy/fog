import { CodedError } from "@repo/core/lib/error";
import {
  backoffMs,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DONE_RETENTION_MS,
  MAX_JOBS_PER_ALARM,
  POISON_RETENTION_MS,
  PRUNE_ROW_LIMIT,
} from "@repo/core/lib/jobBudgets";
import type { JobKind } from "@repo/core/lib/jobKind";
import {
  type JobContextBase,
  type JobHandler,
  UNIMPLEMENTED_JOB_KIND,
} from "./registry";
import {
  claimJob,
  completeJob,
  failJob,
  type JobRow,
  listRunnable,
  poisonJob,
  pruneCompleted,
  releaseJob,
} from "./table";

/**
 * Runs the jobs that are due, then prunes terminal rows.
 *
 * Execution is at-least-once: a DO can be reset the instant after a send
 * succeeded but before the row was marked done, so **every handler must be
 * idempotent**. There is likewise no ordering guarantee between kinds — two
 * jobs in different DOs share neither a clock nor a queue.
 *
 * Retry lives here and only here. Never delegated to the platform, and never
 * thrown out of `alarm()`.
 */

/**
 * Terminal reasons carry the failure's *identity*, never its message: an
 * arbitrary error string can contain a canonical address, an hmac, a locator,
 * a caller token or a reset token, and `terminal_reason` is read by operators
 * and retained for the row's lifetime.
 */
function terminalReasonFor(error: unknown): string {
  if (error instanceof CodedError) {
    return `${error.name}:${error.code}`;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "UnknownError";
}

async function runOne<TCtx extends JobContextBase>(
  context: TCtx,
  handler: JobHandler<TCtx> | undefined,
  row: JobRow,
): Promise<"yield" | "settled"> {
  const { sql, now, ownerToken } = context;

  if (handler === undefined) {
    poisonJob(sql, row.operation_key, ownerToken, now, UNIMPLEMENTED_JOB_KIND);
    return "settled";
  }

  try {
    const outcome = await handler(context, row);
    if (outcome.kind === "yield") {
      releaseJob(sql, row.operation_key, ownerToken);
      return "yield";
    }
    if (outcome.kind === "terminal") {
      poisonJob(sql, row.operation_key, ownerToken, now, outcome.reason);
      return "settled";
    }
    completeJob(
      sql,
      row.operation_key,
      ownerToken,
      now,
      outcome.kind === "rearm" ? outcome.nextRunAt : null,
    );
    return "settled";
  } catch (error) {
    // The one broad catch the architecture allows outside a boundary: a single
    // failing job must abort neither the rest of the queue nor `alarm()`.
    // An OCC conflict is not swallowed either — it lands in `terminal_reason`.
    const attempt = row.attempt + 1;
    if (attempt >= DEFAULT_MAX_ATTEMPTS) {
      poisonJob(
        sql,
        row.operation_key,
        ownerToken,
        now,
        terminalReasonFor(error),
      );
    } else {
      failJob(
        sql,
        row.operation_key,
        ownerToken,
        now,
        attempt,
        now + backoffMs(attempt),
      );
    }
    context.logger.error("job failed", {
      operationKey: row.operation_key,
      kind: row.kind,
      attempt,
      cause: error,
    });
    return "settled";
  }
}

export async function runDueJobs<TCtx extends JobContextBase>(
  context: TCtx,
  handlers: Partial<Record<JobKind, JobHandler<TCtx>>>,
  now: number,
): Promise<void> {
  const { sql } = context;
  // Volatile, not a column: a job that yielded must not be re-claimed during
  // *this* wake-up, but the exclusion has no meaning across wake-ups.
  const yielded: string[] = [];
  let executed = 0;

  while (executed < MAX_JOBS_PER_ALARM) {
    const rows = listRunnable(sql, now, MAX_JOBS_PER_ALARM - executed, yielded);
    if (rows.length === 0) break;

    let progressed = false;
    for (const row of rows) {
      if (executed >= MAX_JOBS_PER_ALARM) break;
      if (
        !claimJob(
          sql,
          row.operation_key,
          now,
          context.ownerToken,
          DEFAULT_LEASE_MS,
        )
      ) {
        continue;
      }
      progressed = true;
      executed += 1;
      const result = await runOne(context, handlers[row.kind as JobKind], row);
      if (result === "yield") {
        yielded.push(row.operation_key);
      }
    }
    if (!progressed) break;
  }

  pruneCompleted(
    sql,
    now,
    PRUNE_ROW_LIMIT,
    DONE_RETENTION_MS,
    POISON_RETENTION_MS,
  );
}
