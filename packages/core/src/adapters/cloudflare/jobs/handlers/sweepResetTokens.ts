import {
  CHUNK_BUDGETS,
  MIN_RESUME_INTERVAL_MS,
} from "@repo/core/lib/jobBudgets";
import { all, one, type Sql } from "../../sql/exec";
import type { IdentityDirectoryJobContext, JobHandler } from "../registry";

/**
 * Expiry sweep for `password_reset_tokens` — class (A), so it re-arms itself
 * from a drive signal instead of settling to `done` while rows remain.
 *
 * The work predicate is `expires_at < now` and the drive signal is the minimum
 * of the very same column over **all** rows. Narrowing the drive signal to
 * "rows already expired" would be the classic mistake: the sweep would fall to
 * `done` with unexpired tokens still on file and never wake for them, leaving a
 * bearer credential alive past its TTL in any bucket nobody else touches.
 */

function deleteExpiredChunk(sql: Sql, now: number, limit: number): number {
  return all(
    sql,
    `DELETE FROM password_reset_tokens
      WHERE token_id IN (
        SELECT token_id FROM password_reset_tokens
         WHERE expires_at < ?
         ORDER BY expires_at
         LIMIT ?
      )
    RETURNING 1`,
    now,
    limit,
  ).length;
}

export const sweepResetTokens: JobHandler<IdentityDirectoryJobContext> = async (
  context,
) => {
  const { ctx, sql, now, logger } = context;
  const budget = CHUNK_BUDGETS["sweep-reset-tokens"];
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
      "SELECT min(expires_at) AS next FROM password_reset_tokens",
    )?.next ?? null;
  if (earliest === null) return { kind: "done" };
  if (earliest <= now && swept === 0) {
    logger.warn(
      "sweep-reset-tokens found a due drive signal with no work to do; clamping the re-arm",
    );
    return { kind: "rearm", nextRunAt: now + MIN_RESUME_INTERVAL_MS };
  }
  return { kind: "rearm", nextRunAt: earliest };
};
