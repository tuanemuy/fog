import type { TrashQueryPort } from "@repo/core/domain/trash/ports/trashQueryPort";

/**
 * The trash read side over this DO's three trashed-row sets. Each branch is
 * answered from its own `*_purge_idx`; `documents` and `topics` are empty
 * until the knowledge slice, but the statement names them from the start
 * so the wake-up material never silently narrows to memos.
 */
export function createTrashQueryPort(sql: SqlStorage): TrashQueryPort {
  return {
    findEarliestPurgeAfter() {
      const row = sql
        .exec<{ v: number | null }>(
          `SELECT min(purge_after) AS v FROM (
             SELECT purge_after FROM memos WHERE status = 'trashed'
             UNION ALL SELECT purge_after FROM documents WHERE status = 'trashed'
             UNION ALL SELECT purge_after FROM topics WHERE status = 'trashed'
           )`,
        )
        .one();
      return row.v === null ? null : new Date(row.v);
    },
  };
}
