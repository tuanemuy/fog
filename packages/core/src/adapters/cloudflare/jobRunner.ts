import {
  backoffDelayMs,
  type DeliveryTuning,
} from "@repo/core/application/delivery/tuning";
import type { JobKind } from "@repo/core/application/delivery/types";
import {
  isConflictError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
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
import {
  crownedToken,
  forwardTokenFor,
  forwardTokenOf,
  operationIdOf,
  terminalReason,
} from "./terminalReason";

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
 * `finished` may carry a `commit` too: a cleanup's last stage writes its
 *   material away in the same `transactionSync` as the row's `done`
 *   (S4 / L3 / C1 of `spec/recovery/index.md`), so the two land or roll
 *   back together.
 * `poison` — **a cleanup stage only**: the material it needs is gone
 *   (S1 / L1 cannot read their row), so retrying repeats the same verdict.
 *   The row terminates `poison` with `cleanup-material-lost:*` whatever
 *   `attempt` says. A forward handler answering this is a contract
 *   violation and is treated as a failure.
 *
 * `commit` is **synchronous**, and its `undefined` return type is what
 * enforces it: a `void` return type accepts a `Promise` as well, and with
 * it an `async` closure — which cannot run inside `transactionSync` and
 * would let the release commit on its own.
 */
export type JobHandlerResult =
  | Readonly<{ kind: "finished"; commit?: (sql: SqlStorage) => undefined }>
  | Readonly<{ kind: "rearm"; nextRunAt: Date }>
  | Readonly<{
      kind: "yield";
      nextRunAt: Date;
      commit?: (sql: SqlStorage) => undefined;
    }>
  | Readonly<{ kind: "poison"; reason: "material-lost" }>;

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
 * The selector reads the row's state through `sql` when the answer
 * depends on it (`resume-credential-change`: the mapping's
 * `change_state`). Which kinds have a stage, what each does and how long
 * its materials live are declared in `spec/recovery/index.md`; the same
 * selector decides both the entry into terminal mode and what a row in
 * it runs.
 */
export type TerminalStageSelector = (
  row: JobRow,
  sql: SqlStorage,
) => JobHandler | null;

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
    // Whether this wake-up ran a cleanup stage: decides how a failure
    // ends (a cleanup burns out with a crown, a forward re-confirms).
    let stageRan = false;
    try {
      // `status IN ('pending','running') AND terminal_reason IS NOT NULL`
      // is the definition of terminal mode. A row in it stops advancing
      // and runs its roll-back stage instead — but only while such a
      // stage exists: if the row's state changed and the stage went
      // away, or the row was re-submitted, it resumes advancing.
      const inTerminalMode = row.terminal_reason !== null;
      const stage = inTerminalMode
        ? selectTerminalStage(row, storage.sql)
        : null;
      const handler = stage ?? registry[row.kind as JobKind] ?? null;
      stageRan = stage !== null;
      if (handler === null) {
        throw new SystemError(
          SystemErrorCode.JobHandlerMissing,
          `No handler registered for job kind ${row.kind}`,
        );
      }
      const handlerResult = await handler({
        storage,
        row,
        payload: JSON.parse(row.payload) as unknown,
        ownerToken,
        now,
        tuning,
      });
      if (handlerResult.kind === "poison" && stage === null) {
        throw new SystemError(
          SystemErrorCode.UnclassifiedError,
          `A forward handler for ${row.kind} declared lost material`,
        );
      }
      result = handlerResult;
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
            stageRan,
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
        applyJobResult(storage, row, ownerToken, result, now, stageRan),
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
  stageRan: boolean,
): boolean {
  const sql = storage.sql;
  if (result.kind === "finished") {
    // A cleanup's last stage and the row's `done` land together; the
    // reason stays as the record that this row once confirmed it could
    // not advance (`COALESCE` in the statement keeps it).
    result.commit?.(sql);
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
  if (result.kind === "poison") {
    // Material lost: the crown says the cleanup ran and found nothing to
    // clean, whatever `attempt` was. `stageRan` is true here by the
    // check in the pass loop.
    void stageRan;
    return finalizeRow(
      sql,
      JOBS_TABLE,
      row.operation_key,
      ownerToken,
      "failed",
      now,
      terminalReason(
        crownedToken(
          "cleanup-material-lost",
          forwardTokenOf(row.terminal_reason),
        ),
        operationIdOf(parsePayload(row)),
      ),
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

/** What a failed run does to its row — the pure half of {@link applyJobFailure}. */
export type FailureOutcome =
  | Readonly<{ kind: "backoff"; attempt: number }>
  | Readonly<{ kind: "enter-terminal"; reason: string }>
  | Readonly<{ kind: "poison"; reason: string }>;

export type FailureFacts = Readonly<{
  error: unknown;
  attempt: number;
  maxAttempts: number;
  /** The row's current `terminal_reason`. */
  currentReason: string | null;
  /** Whether this wake-up ran a cleanup stage rather than the forward. */
  stageRan: boolean;
  /** Whether a cleanup stage exists for the row's state (asked only for a forward failure). */
  hasStage: () => boolean;
  operationId: string | null;
}>;

/**
 * The seven terminal-mode triggers of `spec/recovery/index.md` plus the
 * ordinary backoff, decided from three facts: whether the row is already
 * in terminal mode, whether a cleanup stage ran this wake-up, and
 * whether the failure confirms non-progress now (`ConflictError`, or the
 * ceiling).
 *
 * - forward, not confirmed → backoff
 * - forward, confirmed, a stage exists → **enter terminal mode** (the
 *   reason is written, `attempt` restarts, the row stays runnable)
 * - forward, confirmed, no stage → `poison` with the forward token; for
 *   a row already in terminal mode this is the *re-confirmation*, and
 *   the reason is replaced by the current one
 * - cleanup, under the ceiling → backoff, the reason untouched
 * - cleanup, at the ceiling → `poison` with `cleanup-exhausted:*`
 *
 * A cleanup has no notion of "confirmed": a `ConflictError` out of one
 * of its RPCs is a failure like any other and spends the backoff.
 */
export function failureOutcome(facts: FailureFacts): FailureOutcome {
  const nextAttempt = facts.attempt + 1;
  const exhausted = nextAttempt >= facts.maxAttempts;
  if (facts.stageRan) {
    if (!exhausted) return { kind: "backoff", attempt: nextAttempt };
    return {
      kind: "poison",
      reason: terminalReason(
        crownedToken("cleanup-exhausted", forwardTokenOf(facts.currentReason)),
        facts.operationId,
      ),
    };
  }
  if (!exhausted && !isConflictError(facts.error)) {
    return { kind: "backoff", attempt: nextAttempt };
  }
  const reason = terminalReason(
    forwardTokenFor(facts.error),
    facts.operationId,
  );
  if (facts.currentReason === null && facts.hasStage()) {
    return { kind: "enter-terminal", reason };
  }
  return { kind: "poison", reason };
}

function applyJobFailure(
  storage: DurableObjectStorage,
  row: JobRow,
  ownerToken: string,
  error: unknown,
  now: number,
  tuning: DeliveryTuning,
  selectTerminalStage: TerminalStageSelector,
  stageRan: boolean,
): boolean {
  const sql = storage.sql;
  const outcome = failureOutcome({
    error,
    attempt: row.attempt,
    maxAttempts: tuning.jobsMaxAttempts,
    currentReason: row.terminal_reason,
    stageRan,
    hasStage: () => selectTerminalStage(row, sql) !== null,
    operationId: operationIdOf(parsePayload(row)),
  });
  if (outcome.kind === "backoff") {
    return releaseWithBackoff(
      sql,
      JOBS_TABLE,
      row.operation_key,
      ownerToken,
      outcome.attempt,
      now +
        backoffDelayMs(
          outcome.attempt,
          tuning.jobsBackoffBaseMs,
          tuning.jobsBackoffMaxDelayMs,
        ),
    );
  }
  if (outcome.kind === "enter-terminal") {
    // Terminal mode: the reason is written while the row stays runnable
    // and `completed_at` is deliberately not written. No extra wait and
    // no new operating value — the next run time is what the ordinary
    // backoff rule gives for `attempt = 0`.
    return updateMatchedRow(
      sql,
      `UPDATE jobs SET status = 'pending', attempt = 0, terminal_reason = ?,
         next_run_at = ?, lease_until = NULL, owner_token = NULL
       WHERE operation_key = ? AND owner_token = ?`,
      outcome.reason,
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
  // `poison`: `finalizeRow` keeps a NULL reason, so a re-confirmation
  // hands the current reason in and it replaces the old one.
  return finalizeRow(
    sql,
    JOBS_TABLE,
    row.operation_key,
    ownerToken,
    "failed",
    now,
    outcome.reason,
  );
}

function parsePayload(row: JobRow): unknown {
  try {
    return JSON.parse(row.payload) as unknown;
  } catch {
    return null;
  }
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
