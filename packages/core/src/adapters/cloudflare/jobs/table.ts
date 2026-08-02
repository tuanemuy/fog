import { ConflictError } from "@repo/core/application/errors";
import type { EnqueueJobArgs } from "@repo/core/application/execution/jobs";
import { REARMING_KINDS } from "@repo/core/lib/jobKind";
import { all, one, run, type Sql } from "../sql/exec";

/**
 * The `jobs` table. One DO has one Alarm, so every kind of deferred work is
 * multiplexed onto this table and the Alarm is re-armed at the earliest
 * `next_run_at`.
 *
 * `enqueueJob` is the **only** write path usecases have into this table; claim
 * / complete / backoff / prune belong to the runner and reach the same row
 * without going through that door.
 */

export type JobStatus = "pending" | "running" | "done" | "poison";

export type JobRow = {
  operation_key: string;
  kind: string;
  payload: string;
  payload_digest: string;
  attempt: number;
  next_run_at: number | null;
  status: string;
  lease_until: number | null;
  owner_token: string | null;
  provider_idempotency_key: string | null;
  terminal_reason: string | null;
  completed_at: number | null;
};

export type { EnqueueJobArgs };

const REARMING: ReadonlySet<string> = new Set(REARMING_KINDS);

/**
 * A digest over the payload **excluding** `nextRunAt`. Including it would make
 * every pull-forward re-enqueue look like a conflicting payload.
 */
export function payloadDigest(payload: unknown): string {
  const json = JSON.stringify(payload ?? null);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Convergence rules — **the order matters**. (2) and (3) take precedence over
 * (1) and over the `payload_digest` rule, because a terminal row has a NULL
 * `next_run_at` (so "earlier" is undefined) and because a payload difference
 * on a finished row is the input to the next run, not a conflict.
 *
 * `now` is part of the uniform store signature; convergence needs only the
 * caller-supplied `nextRunAt`.
 */
export function enqueueJob(sql: Sql, _now: number, args: EnqueueJobArgs): void {
  const digest = payloadDigest(args.payload);
  const payload = JSON.stringify(args.payload ?? null);
  const existing = one<JobRow>(
    sql,
    "SELECT * FROM jobs WHERE operation_key = ?",
    args.operationKey,
  );

  // (1) No row yet.
  if (existing === null) {
    run(
      sql,
      `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, provider_idempotency_key, terminal_reason, completed_at)
       VALUES (?, ?, ?, ?, 0, ?, 'pending', NULL, NULL, ?, NULL, NULL)`,
      args.operationKey,
      args.kind,
      payload,
      digest,
      args.nextRunAt,
      args.providerIdempotencyKey ?? null,
    );
    return;
  }

  // (2) Poison rows come back regardless of kind. The same row is revived —
  // never a second one, because `operation_key` *is* the job's identity — and
  // `terminal_reason` is left in place as the record of why it stopped.
  if (existing.status === "poison") {
    run(
      sql,
      `UPDATE jobs
          SET status = 'pending', attempt = 0, next_run_at = ?, payload = ?,
              payload_digest = ?, lease_until = NULL, owner_token = NULL,
              completed_at = NULL
        WHERE operation_key = ?`,
      args.nextRunAt,
      payload,
      digest,
      args.operationKey,
    );
    return;
  }

  // (3) Done rows come back only for the five re-arming kinds. For the other
  // seven a `done` row means "that one unit of work was served", so a repeat
  // enqueue is a duplicate request, not a new job — reviving it would let a
  // burst of reset requests scale wake-ups with request count.
  if (existing.status === "done") {
    if (!REARMING.has(existing.kind)) return;
    run(
      sql,
      `UPDATE jobs
          SET status = 'pending', attempt = 0, next_run_at = ?, payload = ?,
              payload_digest = ?, lease_until = NULL, owner_token = NULL,
              completed_at = NULL
        WHERE operation_key = ?`,
      args.nextRunAt,
      payload,
      digest,
      args.operationKey,
    );
    return;
  }

  // Runnable set: a differing payload is a genuine conflict.
  if (existing.payload_digest !== digest) {
    throw new ConflictError(
      "JOB_PAYLOAD_MISMATCH",
      `Job ${args.operationKey} is already queued with a different payload`,
    );
  }

  // A `running` row is not rescheduled from the side, and a `pending` row only
  // ever moves earlier.
  if (existing.status !== "pending") return;
  if (existing.next_run_at !== null && existing.next_run_at <= args.nextRunAt) {
    return;
  }
  run(
    sql,
    "UPDATE jobs SET next_run_at = ? WHERE operation_key = ? AND status = 'pending'",
    args.nextRunAt,
    args.operationKey,
  );
}

/**
 * The second disjunct **must** keep `status = 'running'`: without it, a `done`
 * or `poison` row that still carries a stale `lease_until` becomes reclaimable.
 */
export function claimJob(
  sql: Sql,
  operationKey: string,
  now: number,
  ownerToken: string,
  leaseMs: number,
): boolean {
  const rows = all(
    sql,
    `UPDATE jobs
        SET status = 'running', lease_until = ?, owner_token = ?
      WHERE operation_key = ?
        AND (status = 'pending' OR (status = 'running' AND lease_until < ?))
      RETURNING 1`,
    now + leaseMs,
    ownerToken,
    operationKey,
    now,
  );
  return rows.length > 0;
}

export function listRunnable(
  sql: Sql,
  now: number,
  limit: number,
  exclude: readonly string[],
): JobRow[] {
  const rows = all<JobRow>(
    sql,
    `SELECT * FROM jobs
      WHERE status IN ('pending','running')
        AND next_run_at IS NOT NULL
        AND next_run_at <= ?
        AND (status = 'pending' OR lease_until IS NULL OR lease_until < ?)
      ORDER BY next_run_at
      LIMIT ?`,
    now,
    now,
    limit + exclude.length,
  );
  const excluded = new Set(exclude);
  return rows.filter((row) => !excluded.has(row.operation_key)).slice(0, limit);
}

/**
 * `nextRunAt === null` means the job is finished: one statement writes
 * `completed_at` and clears `lease_until` / `owner_token` / `next_run_at`
 * together, so no intermediate shape exists. A non-null value is a re-arm
 * instead, which returns the row to `pending` and leaves `completed_at` unset.
 */
export function completeJob(
  sql: Sql,
  operationKey: string,
  ownerToken: string,
  now: number,
  nextRunAt: number | null,
): void {
  if (nextRunAt === null) {
    run(
      sql,
      `UPDATE jobs
          SET status = 'done', completed_at = ?, lease_until = NULL,
              owner_token = NULL, next_run_at = NULL
        WHERE operation_key = ? AND owner_token = ?`,
      now,
      operationKey,
      ownerToken,
    );
    return;
  }
  run(
    sql,
    `UPDATE jobs
        SET status = 'pending', next_run_at = ?, lease_until = NULL,
            owner_token = NULL, attempt = 0, completed_at = NULL
      WHERE operation_key = ? AND owner_token = ?`,
    nextRunAt,
    operationKey,
    ownerToken,
  );
}

export function failJob(
  sql: Sql,
  operationKey: string,
  ownerToken: string,
  _now: number,
  attempt: number,
  nextRunAt: number,
): void {
  run(
    sql,
    `UPDATE jobs
        SET status = 'pending', attempt = ?, next_run_at = ?, lease_until = NULL,
            owner_token = NULL
      WHERE operation_key = ? AND owner_token = ?`,
    attempt,
    nextRunAt,
    operationKey,
    ownerToken,
  );
}

/**
 * Terminal. Same single-statement shape as `completeJob`, which is what makes
 * "the terminal state is uniform" true rather than aspirational.
 *
 * `terminalReason` carries the reason and the `operationId` only — never PII
 * and never a reusable secret (canonical, hmac, locator, `callerToken`,
 * `changeAuthToken`, `passwordVerifier`, reset tokens).
 */
export function poisonJob(
  sql: Sql,
  operationKey: string,
  ownerToken: string,
  now: number,
  terminalReason: string,
): void {
  run(
    sql,
    `UPDATE jobs
        SET status = 'poison', terminal_reason = ?, completed_at = ?,
            lease_until = NULL, owner_token = NULL, next_run_at = NULL
      WHERE operation_key = ? AND owner_token = ?`,
    terminalReason,
    now,
    operationKey,
    ownerToken,
  );
}

/** Chunk-budget exhaustion: hand the row back for the next wake-up. */
export function releaseJob(
  sql: Sql,
  operationKey: string,
  ownerToken: string,
): void {
  run(
    sql,
    `UPDATE jobs
        SET status = 'pending', lease_until = NULL, owner_token = NULL
      WHERE operation_key = ? AND owner_token = ?`,
    operationKey,
    ownerToken,
  );
}

export function earliestNextRunAt(sql: Sql): number | null {
  const row = one<{ next_run_at: number | null }>(
    sql,
    `SELECT min(next_run_at) AS next_run_at FROM jobs
      WHERE status IN ('pending','running') AND next_run_at IS NOT NULL`,
  );
  return row?.next_run_at ?? null;
}

/** Deletes terminal rows past their retention, bounded by `limit`. */
export function pruneCompleted(
  sql: Sql,
  now: number,
  limit: number,
  doneRetentionMs: number,
  poisonRetentionMs: number,
): number {
  const rows = all(
    sql,
    `DELETE FROM jobs
      WHERE operation_key IN (
        SELECT operation_key FROM jobs
         WHERE completed_at IS NOT NULL
           AND (
             (status = 'done'   AND completed_at < ?) OR
             (status = 'poison' AND completed_at < ?)
           )
         ORDER BY completed_at
         LIMIT ?
      )
      RETURNING 1`,
    now - doneRetentionMs,
    now - poisonRetentionMs,
    limit,
  );
  return rows.length;
}
