import {
  CHUNK_BUDGETS,
  MIN_RESUME_INTERVAL_MS,
} from "@repo/core/lib/jobBudgets";
import { all, one, type Sql } from "../../sql/exec";
import type { IdentityDirectoryJobContext, JobHandler } from "../registry";

/**
 * TTL sweep for abandoned signup reservations — class (A).
 *
 * **A row carrying `saga_committed` is excluded from the work predicate *and*
 * from the drive signal.** That flag means some other bucket has already gone
 * past the point of no return, so removing this reservation would unmake a
 * uniqueness claim the rest of the saga is still relying on. Excluding it from
 * only one of the two would be worse than excluding it from neither: the sweep
 * would keep waking for a row it is forbidden to touch, forever.
 *
 * The reservation row itself is *not* the saga's terminus — the reverse
 * information a recovery needs (`locators`, `candidate_user_id`, `caller_token`)
 * lives on it, and #45 designs what reads them. What this sweep deletes is only
 * a reservation whose TTL ran out with no commit anywhere.
 */

function deleteExpiredChunk(sql: Sql, now: number, limit: number): number {
  return all(
    sql,
    `DELETE FROM credential_mappings
      WHERE rowid IN (
        SELECT rowid FROM credential_mappings
         WHERE status = 'reserved'
           AND reserved_until < ?
           AND saga_committed IS NULL
         ORDER BY reserved_until
         LIMIT ?
      )
    RETURNING 1`,
    now,
    limit,
  ).length;
}

export const sweepReservations: JobHandler<
  IdentityDirectoryJobContext
> = async (context) => {
  const { ctx, sql, now, logger } = context;
  const budget = CHUNK_BUDGETS["sweep-reservations"];
  let swept = 0;
  let drained = false;

  for (let chunk = 0; chunk < budget.maxChunks && !drained; chunk += 1) {
    const deleted = ctx.storage.transactionSync(() =>
      deleteExpiredChunk(sql, now, budget.chunkRowLimit),
    );
    swept += deleted;
    if (deleted === 0) drained = true;
  }
  if (!drained) return { kind: "yield" };

  const earliest =
    one<{ next: number | null }>(
      sql,
      `SELECT min(reserved_until) AS next FROM credential_mappings
        WHERE status = 'reserved' AND saga_committed IS NULL`,
    )?.next ?? null;
  if (earliest === null) return { kind: "done" };
  if (earliest <= now && swept === 0) {
    logger.warn(
      "sweep-reservations found a due drive signal with no work to do; clamping the re-arm",
    );
    return { kind: "rearm", nextRunAt: now + MIN_RESUME_INTERVAL_MS };
  }
  return { kind: "rearm", nextRunAt: earliest };
};
