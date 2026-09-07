import type { JobHandler } from "../jobRunner";

/**
 * Deletes reservations past `reserved_until` that no saga has committed
 * (`cm_reservation_idx`), one chunk per wake-up, and re-arms on the next
 * expiry while any such row remains.
 */
export function createSweepReservationsHandler(): JobHandler {
  return async ({ storage, now, tuning }) => {
    const sql = storage.sql;
    storage.transactionSync(() => {
      sql.exec(
        `DELETE FROM credential_mappings WHERE rowid IN (
           SELECT rowid FROM credential_mappings
           WHERE status = 'reserved' AND saga_committed IS NULL AND reserved_until < ?
           ORDER BY reserved_until LIMIT ?
         )`,
        now,
        tuning.jobsMaxRowsPerChunk,
      );
    });
    const next = sql
      .exec<{ v: number | null }>(
        "SELECT min(reserved_until) AS v FROM credential_mappings WHERE status = 'reserved' AND saga_committed IS NULL",
      )
      .one().v;
    if (next === null) return { kind: "finished" };
    return { kind: "rearm", nextRunAt: new Date(Math.max(next, now)) };
  };
}
