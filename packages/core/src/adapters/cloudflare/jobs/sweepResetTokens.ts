import type { JobHandler } from "../jobRunner";

/**
 * `sweep-reset-tokens`: expired reset tokens (used or not — a used one is
 * kept until its `expires_at` as the send-materials guard's negative
 * answer) and expired throttle windows, one chunk of each per wake-up;
 * re-arms on the earliest remaining expiry while any row remains.
 */
export function createSweepResetTokensHandler(): JobHandler {
  return async ({ storage, now, tuning }) => {
    const sql = storage.sql;
    storage.transactionSync(() => {
      sql.exec(
        `DELETE FROM password_reset_tokens WHERE rowid IN (
           SELECT rowid FROM password_reset_tokens WHERE expires_at < ?
           ORDER BY expires_at LIMIT ?
         )`,
        now,
        tuning.jobsMaxRowsPerChunk,
      );
      sql.exec(
        `DELETE FROM reset_request_windows WHERE rowid IN (
           SELECT rowid FROM reset_request_windows WHERE expires_at < ?
           ORDER BY expires_at LIMIT ?
         )`,
        now,
        tuning.jobsMaxRowsPerChunk,
      );
    });
    const next = sql
      .exec<{ v: number | null }>(
        `SELECT min(v) AS v FROM (
           SELECT min(expires_at) AS v FROM password_reset_tokens
           UNION ALL
           SELECT min(expires_at) AS v FROM reset_request_windows
         )`,
      )
      .one().v;
    if (next === null) return { kind: "finished" };
    return { kind: "rearm", nextRunAt: new Date(Math.max(next, now + 1)) };
  };
}
