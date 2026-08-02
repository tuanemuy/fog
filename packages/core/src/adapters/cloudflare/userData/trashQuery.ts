import { all, one, type Sql } from "../sql/exec";

/**
 * Queries backing the `purge-trash` job.
 *
 * They live apart from the memo / knowledge repositories because #37 does not
 * build those (ADR-001) but does have to run trash retention, which needs
 * exactly these three shapes across the three trashable tables.
 */

// Interpolated into SQL below. Safe, and deliberately not parameterised: a
// table name cannot be a bind parameter, and this tuple is a closed literal no
// caller can influence. ADR-009's ban on `${` covers the DDL strings, whose
// point is that they are transcribed verbatim from the spec.
const TRASHABLE = ["memos", "topics", "documents"] as const;

export type TrashItemType = "memo" | "topic" | "document";

export type TrashItem = Readonly<{
  type: TrashItemType;
  id: string;
  purgeAfter: number;
}>;

const TYPE_OF: Readonly<Record<(typeof TRASHABLE)[number], TrashItemType>> = {
  memos: "memo",
  topics: "topic",
  documents: "document",
};

/**
 * The drive signal for re-arming `purge-trash`: the earliest moment any
 * trashed item becomes purgeable, or `null` when the trash is empty.
 *
 * Reading this **narrower** than the work predicate makes the job fall to
 * `done` after one run and never wake again, silently extending retention
 * forever; reading it wider makes the DO wake for eternity at one write each
 * time. It is exactly the minimum over the same predicate the work uses.
 */
export function findEarliestPurgeAfter(sql: Sql): number | null {
  let earliest: number | null = null;
  for (const table of TRASHABLE) {
    const row = one<{ purge_after: number | null }>(
      sql,
      `SELECT min(purge_after) AS purge_after FROM ${table} WHERE status = 'trashed'`,
    );
    const value = row?.purge_after ?? null;
    if (value !== null && (earliest === null || value < earliest)) {
      earliest = value;
    }
  }
  return earliest;
}

/** Items whose retention has elapsed, oldest first, bounded by `limit`. */
export function listItemsToPurge(
  sql: Sql,
  now: number,
  limit: number,
): TrashItem[] {
  const items: TrashItem[] = [];
  for (const table of TRASHABLE) {
    const rows = all<{ id: string; purge_after: number }>(
      sql,
      `SELECT id, purge_after FROM ${table}
        WHERE status = 'trashed' AND purge_after <= ?
        ORDER BY purge_after
        LIMIT ?`,
      now,
      limit,
    );
    for (const row of rows) {
      items.push({
        type: TYPE_OF[table],
        id: row.id,
        purgeAfter: row.purge_after,
      });
    }
  }
  return items.sort((a, b) => a.purgeAfter - b.purgeAfter).slice(0, limit);
}

/**
 * Recomputes `purge_after` for one chunk of trashed items and reports how many
 * rows it changed.
 *
 * **The predicate is self-consuming**: `purge_after <> <new value>` stops
 * matching a row the moment that row is updated. That is the only reason
 * `purge-trash` needs no persistent cursor — a naive `WHERE status='trashed'`
 * never shrinks, so every interruption restarts at the beginning and the pass
 * never finishes. Do not add a non-self-consuming `UPDATE` to this job; if one
 * is ever needed, the job moves to the cursor-carrying side instead.
 */
export function recalcPurgeAfterChunk(
  sql: Sql,
  retentionDays: number,
  limit: number,
  now: number,
): number {
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  let updated = 0;
  for (const table of TRASHABLE) {
    const rows = all<{ id: string }>(
      sql,
      `UPDATE ${table}
          SET purge_after = trashed_at + ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM ${table}
           WHERE status = 'trashed' AND purge_after <> trashed_at + ?
           LIMIT ?
        )
      RETURNING id`,
      retentionMs,
      now,
      retentionMs,
      limit,
    );
    updated += rows.length;
  }
  return updated;
}
