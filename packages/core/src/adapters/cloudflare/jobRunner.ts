import {
  backoffDelayMs,
  type DeliveryTuning,
} from "@repo/core/application/delivery/tuning";
import type { JobKind } from "@repo/core/application/delivery/types";
import type { Logger } from "@repo/core/application/ports/logger";
import {
  claimRows,
  failureLabel,
  finalizeRow,
  JOBS_TABLE,
  OUTBOX_TABLE,
  pruneCompleted,
  releaseForNextWakeUp,
  releaseWithBackoff,
  updateMatchedRow,
} from "./rowRunner";

export type JobRow = Readonly<{
  operation_key: string;
  kind: string;
  payload: string;
  payload_digest: string;
  attempt: number;
  next_run_at: number | null;
  status: string;
  lease_until: number | null;
  owner_token: string | null;
  terminal_reason: string | null;
  completed_at: number | null;
}>;

/**
 * What a handler reports back.
 *
 * `finished` — nothing is left to do; the row terminates as `done`.
 * `rearm` — the driver still has work; the row goes back to `pending` at
 *   the time the handler read from its own source in this same pass.
 *   Convergence rule (1) is deliberately **not** applied to this write:
 *   applying it would drop the update whenever the new due time is later
 *   than the current `next_run_at`, and the row would fall to `done` and
 *   never wake again.
 * `yield` — the chunk-iteration ceiling was reached. The row goes back to
 *   `pending`, the lease is released, and it waits for the next wake-up
 *   rather than being re-claimed in this one. `commit` carries the
 *   progress the handler wants persisted with that release: the runner
 *   runs it inside the very `transactionSync` that issues the release, so
 *   the two land or roll back together as `spec/database/index.md`
 *   requires. Progress written by the handler outside that closure is a
 *   separate transaction and does not have that guarantee.
 *
 * `commit` is **synchronous**, and its `undefined` return type is what
 * enforces it: a `void` return type accepts a `Promise` as well, and with
 * it an `async` closure — which cannot run inside `transactionSync` and
 * would let the release commit on its own.
 */
export type JobHandlerResult =
  | Readonly<{ kind: "finished" }>
  | Readonly<{ kind: "rearm"; nextRunAt: Date }>
  | Readonly<{
      kind: "yield";
      nextRunAt: Date;
      commit?: (sql: SqlStorage) => undefined;
    }>;

export type JobHandlerContext = Readonly<{
  storage: DurableObjectStorage;
  row: JobRow;
  payload: unknown;
  ownerToken: string;
  now: number;
  tuning: DeliveryTuning;
}>;

/**
 * Runs one claimed job.
 *
 * **The three-tier ceilings on chunked work are the handler's to honour.**
 * `jobsMaxChunkIterations` / `jobsMaxRowsPerChunk` reach it through
 * {@link JobHandlerContext.tuning}, and the runner cannot enforce them:
 * the iteration happens inside the handler, and all the runner sees is the
 * `yield` the handler reports when it stops. Only the per-pass job count
 * (`jobsMaxJobsPerPass`) is held by the runner itself.
 */
export type JobHandler = (
  context: JobHandlerContext,
) => Promise<JobHandlerResult>;

export type JobHandlerRegistry = Partial<Record<JobKind, JobHandler>>;

/**
 * Selects the roll-back stage a row in terminal mode should run.
 *
 * **Whether a roll-back stage exists is decided per row, not per kind** —
 * `resume-credential-change` only has one while the mapping is still
 * `pending`. When one exists, exhausting the forward attempt limit writes
 * `terminal_reason` while the row stays runnable (terminal mode) instead
 * of terminating it, and the row becomes `poison` only if the roll-back
 * itself ends without completing.
 *
 * **No handlers and no stages are registered yet, so the default selector
 * answers "no stage" and the terminal-mode write never fires.** The
 * write only happens when a roll-back stage actually exists
 * (`spec/database/index.md`), and which kinds have one, what each does
 * and how long its materials live are declared in
 * `spec/recovery/index.md`.
 */
export type TerminalStageSelector = (row: JobRow) => JobHandler | null;

export const NO_TERMINAL_STAGE: TerminalStageSelector = () => null;

export type JobPassOptions = Readonly<{
  storage: DurableObjectStorage;
  tuning: DeliveryTuning;
  now: number;
  registry: JobHandlerRegistry;
  logger: Logger;
  terminalStage?: TerminalStageSelector;
}>;

/**
 * One jobs pass of `alarm()`.
 *
 * Every job is wrapped in its own `try / catch`: one failing job must
 * neither abort the rest of the pass nor escape `alarm()`. This is one of
 * the two places retry lives inside a DO (the other is the Outbox relay);
 * it is never delegated to the platform.
 *
 * **Running the handler and recording its result are caught separately.**
 * Only the handler failing is a job failure. Once it has returned, a
 * bookkeeping write that throws writes nothing at all — no `attempt`
 * advance, no `poison`, and none of the progress a `yield` hands over —
 * and the row is left `running` for its lease expiry to re-claim, which
 * is the same recovery a DO reset between the two takes. Job execution is
 * at-least-once and every handler is idempotent, so re-running is the
 * correct side to fall on.
 *
 * The count limit is held independently of the relay's, so a backlog in
 * one pass cannot starve the other. Work is bounded by counts and never
 * by elapsed time — `Date.now()` does not advance while code runs.
 */
export async function runJobsPass(options: JobPassOptions): Promise<void> {
  const { storage, tuning, now, registry, logger } = options;
  const selectTerminalStage = options.terminalStage ?? NO_TERMINAL_STAGE;

  const claimed = claimRows<JobRow>(storage, JOBS_TABLE, {
    now,
    limit: tuning.jobsMaxJobsPerPass,
    leaseMs: tuning.jobsLeaseMs,
  });

  for (const { row, ownerToken } of claimed) {
    let result: JobHandlerResult;
    try {
      // `status IN ('pending','running') AND terminal_reason IS NOT NULL`
      // is the definition of terminal mode. A row in it stops advancing
      // and runs its roll-back stage instead — but only while such a
      // stage exists: if the row's state changed and the stage went
      // away, or the row was re-submitted, it resumes advancing.
      const inTerminalMode = row.terminal_reason !== null;
      const stage = selectTerminalStage(row);
      const handler =
        (inTerminalMode ? stage : null) ??
        registry[row.kind as JobKind] ??
        null;
      if (handler === null) {
        throw new Error(`No handler registered for job kind ${row.kind}`);
      }
      result = await handler({
        storage,
        row,
        payload: JSON.parse(row.payload) as unknown,
        ownerToken,
        now,
        tuning,
      });
    } catch (error) {
      logger.error("Job execution failed", {
        kind: row.kind,
        operationKey: row.operation_key,
        cause: failureLabel(error, "Job failed"),
      });
      try {
        const matched = storage.transactionSync(() =>
          applyJobFailure(
            storage,
            row,
            ownerToken,
            error,
            now,
            tuning,
            selectTerminalStage,
          ),
        );
        if (!matched) warnLostLease(logger, row);
      } catch (bookkeepingError) {
        // Even the bookkeeping write is not allowed to escape `alarm()`;
        // the lease expiring is what recovers the row in that case.
        logger.error("Failed to record job failure", {
          kind: row.kind,
          operationKey: row.operation_key,
          cause: failureLabel(bookkeepingError, "Bookkeeping failed"),
        });
      }
      continue;
    }

    try {
      const matched = storage.transactionSync(() =>
        applyJobResult(storage, row, ownerToken, result, now),
      );
      if (!matched) warnLostLease(logger, row);
    } catch (error) {
      logger.error("Failed to record job result", {
        kind: row.kind,
        operationKey: row.operation_key,
        cause: failureLabel(error, "Bookkeeping failed"),
      });
    }
  }
}

/**
 * The claim token has been taken over by a later claim, so the CAS wrote
 * nothing at all. Reporting it is what keeps "zero rows means somebody
 * else holds it" observable rather than indistinguishable from a write
 * that landed; the row itself is left to whoever holds it now.
 */
function warnLostLease(logger: Logger, row: JobRow): void {
  logger.warn("Job bookkeeping matched no row", {
    kind: row.kind,
    operationKey: row.operation_key,
  });
}

function applyJobResult(
  storage: DurableObjectStorage,
  row: JobRow,
  ownerToken: string,
  result: JobHandlerResult,
  now: number,
): boolean {
  const sql = storage.sql;
  if (result.kind === "finished") {
    return finalizeRow(
      sql,
      JOBS_TABLE,
      row.operation_key,
      ownerToken,
      "completed",
      now,
      null,
    );
  }
  if (result.kind === "yield") {
    result.commit?.(sql);
    return releaseForNextWakeUp(
      sql,
      JOBS_TABLE,
      row.operation_key,
      ownerToken,
      result.nextRunAt.getTime(),
    );
  }
  // Re-arm: a successful run, so `attempt` returns to zero.
  return releaseWithBackoff(
    sql,
    JOBS_TABLE,
    row.operation_key,
    ownerToken,
    0,
    result.nextRunAt.getTime(),
  );
}

function applyJobFailure(
  storage: DurableObjectStorage,
  row: JobRow,
  ownerToken: string,
  error: unknown,
  now: number,
  tuning: DeliveryTuning,
  selectTerminalStage: TerminalStageSelector,
): boolean {
  const sql = storage.sql;
  const nextAttempt = row.attempt + 1;

  if (nextAttempt < tuning.jobsMaxAttempts) {
    return releaseWithBackoff(
      sql,
      JOBS_TABLE,
      row.operation_key,
      ownerToken,
      nextAttempt,
      now +
        backoffDelayMs(
          nextAttempt,
          tuning.jobsBackoffBaseMs,
          tuning.jobsBackoffMaxDelayMs,
        ),
    );
  }

  const reason = failureLabel(error, "Job failed");

  // Terminal mode: the forward attempts are spent but a roll-back stage
  // exists for this row, so `terminal_reason` is written while the row
  // stays runnable and `completed_at` is deliberately not written. No
  // extra wait and no new operating value is introduced — the next run
  // time is what the ordinary backoff rule gives for `attempt = 0`.
  if (row.terminal_reason === null && selectTerminalStage(row) !== null) {
    return updateMatchedRow(
      sql,
      `UPDATE jobs SET status = 'pending', attempt = 0, terminal_reason = ?,
         next_run_at = ?, lease_until = NULL, owner_token = NULL
       WHERE operation_key = ? AND owner_token = ?`,
      reason,
      now +
        backoffDelayMs(
          0,
          tuning.jobsBackoffBaseMs,
          tuning.jobsBackoffMaxDelayMs,
        ),
      row.operation_key,
      ownerToken,
    );
  }

  return finalizeRow(
    sql,
    JOBS_TABLE,
    row.operation_key,
    ownerToken,
    "failed",
    now,
    reason,
  );
}

/**
 * The prune that runs at the tail of a wake-up, for both tables.
 *
 * There is no dedicated prune `kind`: it is part of the wake-up, not a
 * job. Only the normally-completed side is deleted — `poison` and
 * `quarantined` rows are retained indefinitely and counted against the
 * 10 GB cap, and the only ways to reduce them are the operator re-drive
 * entries and explicit deletion by an operator.
 *
 * A DO holding nothing but terminated rows never wakes (its runnable sets
 * are empty, so it is disarmed), which means rows past their retention
 * can sit there until the next enqueue. That is expected and is included
 * in the storage estimate.
 */
export function runPrunePass(
  storage: DurableObjectStorage,
  tuning: DeliveryTuning,
  now: number,
): void {
  const sql = storage.sql;
  storage.transactionSync(() => {
    pruneCompleted(
      sql,
      JOBS_TABLE,
      now - tuning.doneRetentionMs,
      tuning.pruneMaxRowsPerPass,
    );
    pruneCompleted(
      sql,
      OUTBOX_TABLE,
      now - tuning.publishedRetentionMs,
      tuning.pruneMaxRowsPerPass,
    );
  });
}
