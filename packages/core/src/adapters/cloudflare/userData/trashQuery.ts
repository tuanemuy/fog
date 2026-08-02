import { all, one, run, type Sql } from "../sql/exec";

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

/**
 * The retention window `purge_after` is computed from, or `null` before the
 * account has been initialised. `purge-trash` reads it rather than taking it as
 * a payload field: a payload copy would go stale the moment the setting changes
 * while the job sits queued, and the job is the thing that has to converge.
 */
export function readTrashRetentionDays(sql: Sql): number | null {
  const row = one<{ trash_retention_days: number }>(
    sql,
    "SELECT trash_retention_days FROM user_settings",
  );
  return row?.trash_retention_days ?? null;
}

/**
 * Documents trashed **as part of** the topic, which is what `trashed_with`
 * records. A document trashed on its own while its topic was still live keeps
 * its own retention clock and is not swept up by the topic's purge.
 */
export function listDocumentsTrashedWithTopic(
  sql: Sql,
  topicId: string,
): string[] {
  return all<{ id: string }>(
    sql,
    "SELECT id FROM documents WHERE topic_id = ? AND trashed_with = ?",
    topicId,
    topicId,
  ).map((row) => row.id);
}

/** Documents that cite the memo, whose projections have to be rebuilt. */
export function listDocumentsCitingMemo(sql: Sql, memoId: string): string[] {
  return all<{ document_id: string }>(
    sql,
    "SELECT document_id FROM source_links WHERE memo_id = ?",
    memoId,
  ).map((row) => row.document_id);
}

export function deleteSourceLinksByMemo(sql: Sql, memoId: string): void {
  run(sql, "DELETE FROM source_links WHERE memo_id = ?", memoId);
}

export function deleteMemoRow(sql: Sql, memoId: string): void {
  run(sql, "DELETE FROM memos WHERE id = ?", memoId);
}

export function deleteDocumentRow(sql: Sql, documentId: string): void {
  run(sql, "DELETE FROM documents WHERE id = ?", documentId);
}

export function deleteTopicRow(sql: Sql, topicId: string): void {
  run(sql, "DELETE FROM topics WHERE id = ?", topicId);
}

export type DocumentProjectionSource = Readonly<{
  id: string;
  topicId: string;
  title: string;
  body: string;
  timestamp: number;
  sourceIds: readonly string[];
}>;

/**
 * Everything the search projection of one document needs, or `null` if the
 * document is gone or trashed.
 *
 * `sourceIds` lists **active** memos only, per the projection's contract: a
 * trashed or hard-deleted memo's id must not surface through search.
 */
export function readDocumentProjectionSource(
  sql: Sql,
  documentId: string,
): DocumentProjectionSource | null {
  const row = one<{
    id: string;
    topic_id: string;
    title: string;
    body: string;
    updated_at: number;
  }>(
    sql,
    `SELECT id, topic_id, title, body, updated_at
       FROM documents WHERE id = ? AND status = 'active'`,
    documentId,
  );
  if (row === null) return null;
  const sourceIds = all<{ memo_id: string }>(
    sql,
    `SELECT sl.memo_id AS memo_id
       FROM source_links sl
       JOIN memos m ON m.id = sl.memo_id
      WHERE sl.document_id = ? AND m.status = 'active'
      ORDER BY sl.memo_id`,
    documentId,
  ).map((source) => source.memo_id);
  return {
    id: row.id,
    topicId: row.topic_id,
    title: row.title,
    body: row.body,
    timestamp: row.updated_at,
    sourceIds,
  };
}
