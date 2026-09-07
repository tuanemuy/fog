import {
  JOB_KIND_POLICY,
  type JobKind,
} from "@repo/core/application/delivery/types";
import { ConflictError } from "@repo/core/application/errors";
import type { EnqueueJobInput } from "@repo/core/application/execution/unitOfWork";
import { canonicalPayloadDigest } from "../payloadDigest";

type ExistingJobRow = Readonly<{
  status: string;
  next_run_at: number | null;
  payload_digest: string;
}>;

/**
 * `enqueueJob` — the single write path into `jobs` from a usecase, plus
 * the migration gate, which seeds `reindex` / `migrate-bulk` through the
 * same function so the convergence rules cannot diverge between the two
 * callers.
 *
 * **Three convergence rules, and that is all of them**
 * (`spec/database/index.md`). Rules (2) and (3) take precedence over both
 * rule (1) and the digest comparison: a terminated row has
 * `next_run_at = NULL`, so "earlier" is undefined for it, and a differing
 * payload on a finished row is the next run's input rather than a
 * conflict.
 *
 *  1. Within the runnable set (`pending` / `running`), only move
 *     `next_run_at` **earlier**; never later. A `running` row's
 *     `next_run_at` is not rewritten at all — a claimed execution is not
 *     nudged from the side. The payload digest is compared here, with
 *     `nextRunAt` excluded from it by construction (the input keeps the
 *     two apart), and a difference raises `ConflictError`.
 *  2. A `poison` row goes back to `pending` regardless of `kind`, with
 *     `attempt = 0`, `completed_at = NULL`, and payload / digest /
 *     `next_run_at` replaced. `terminal_reason` is **kept** — it is the
 *     only record of why the row terminated. No second row is created:
 *     `operation_key` is the job's identity.
 *  3. A `done` row is revived only for the five kinds that re-arm
 *     themselves; the other six treat a re-submission as a duplicate
 *     request and write nothing. Reviving those six would let a duplicate
 *     request restart a completed saga, making wake-ups and rows written
 *     proportional to how many times it was asked for.
 *
 * The `completed_at = NULL` write in (2) and (3) is not optional: the
 * column definition says `pending` / `running` rows carry `NULL`, and a
 * terminated row that keeps its timestamp on the way back violates it.
 */
export function writeEnqueuedJob(
  sql: SqlStorage,
  input: EnqueueJobInput<JobKind>,
): void {
  const payload = JSON.stringify(input.payload);
  const digest = canonicalPayloadDigest(input.payload);
  const nextRunAt = input.nextRunAt.getTime();

  const existing = sql
    .exec<ExistingJobRow>(
      "SELECT status, next_run_at, payload_digest FROM jobs WHERE operation_key = ?",
      input.operationKey,
    )
    .toArray()[0];

  if (!existing) {
    sql.exec(
      `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
       VALUES (?, ?, ?, ?, 0, ?, 'pending', NULL, NULL, NULL, NULL)`,
      input.operationKey,
      input.kind,
      payload,
      digest,
      nextRunAt,
    );
    return;
  }

  if (existing.status === "poison") {
    sql.exec(
      `UPDATE jobs SET status = 'pending', attempt = 0, completed_at = NULL,
         next_run_at = ?, payload = ?, payload_digest = ?
       WHERE operation_key = ?`,
      nextRunAt,
      payload,
      digest,
      input.operationKey,
    );
    return;
  }

  if (existing.status === "done") {
    if (!JOB_KIND_POLICY[input.kind].revivesFromDone) return;
    sql.exec(
      `UPDATE jobs SET status = 'pending', attempt = 0, completed_at = NULL,
         next_run_at = ?, payload = ?, payload_digest = ?
       WHERE operation_key = ?`,
      nextRunAt,
      payload,
      digest,
      input.operationKey,
    );
    return;
  }

  if (existing.payload_digest !== digest) {
    throw new ConflictError(
      "JOB_PAYLOAD_MISMATCH",
      `A runnable job already exists for operation_key=${input.operationKey} with a different payload`,
    );
  }

  if (existing.status === "running") return;
  if (existing.next_run_at !== null && existing.next_run_at <= nextRunAt)
    return;

  sql.exec(
    "UPDATE jobs SET next_run_at = ? WHERE operation_key = ?",
    nextRunAt,
    input.operationKey,
  );
}
