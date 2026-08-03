import { errorIdentity } from "@repo/core/lib/errorIdentity";
import {
  backoffMs,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DONE_RETENTION_MS,
  MAX_JOBS_PER_ALARM,
  POISON_RETENTION_MS,
  PRUNE_ROW_LIMIT,
  SEND_MAIL_RETENTION_MS,
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
 * and retained for the row's lifetime. The log line below obeys the same rule
 * through the same helper — the two used to disagree, and the log was the one
 * that leaked.
 */

/**
 * A correlation handle for a job, safe to log.
 *
 * `operation_key` itself is **not** — a `send-mail` key embeds the canonical
 * address's full-length HMAC, which `lib/directoryLocator.ts` calls the
 * mapping's identity, and the log stream is outside the Durable Object's trust
 * boundary. Eight bytes of SHA-256 correlate two lines about the same row
 * without being a step towards the HMAC.
 */
async function correlationIdFor(operationKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(operationKey),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
    //
    // The settling write itself is deliberately **not** guarded: if storage
    // cannot accept an `UPDATE` (a DO at its 10 GB ceiling fails writes while
    // still serving reads) then nothing else in this queue can make progress
    // either, so the throw is allowed to stop the wake-up. `alarm()`'s own
    // catch turns it into a fixed-interval re-arm rather than an escape.
    const attempt = row.attempt + 1;
    if (attempt >= DEFAULT_MAX_ATTEMPTS) {
      poisonJob(sql, row.operation_key, ownerToken, now, errorIdentity(error));
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
      job: await correlationIdFor(row.operation_key),
      kind: row.kind,
      attempt,
      cause: errorIdentity(error),
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

  pruneCompleted(sql, now, PRUNE_ROW_LIMIT, {
    done: DONE_RETENTION_MS,
    poison: POISON_RETENTION_MS,
    sendMail: SEND_MAIL_RETENTION_MS,
  });
}
