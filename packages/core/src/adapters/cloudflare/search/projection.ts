import { one, run, type Sql } from "../sql/exec";
import { normalizeForIndex } from "./normalize";

/**
 * **The only write path into `search_entries` and `search_fts`.**
 *
 * The repository that writes a `memos` / `documents` / `topics` row **must**
 * call into this module from inside the *same* `transactionSync`. Forgetting
 * to raises no exception — the row is written, the index silently goes stale,
 * and nothing surfaces until a user notices a search result that should not
 * exist. #37 owns no memo / knowledge repository, so the obligation is carried
 * by #2〜#6; this JSDoc is where that obligation is stated.
 *
 * The subtraction side is written with FTS5's special command syntax and the
 * **old** values:
 *
 * ```sql
 * INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', …)
 * ```
 *
 * `DELETE FROM search_fts WHERE rowid = ?` compiles, runs, and corrupts the
 * index: with `content='search_entries'` FTS5 cannot recover the old terms on
 * its own, so a delete that does not carry them leaves them indexed forever.
 * The test that guards this asserts "the old keyword no longer matches", not
 * "two statements were issued" — only the former fails when the syntax is
 * swapped.
 */

export type SearchProjectionRow = Readonly<{
  id: string;
  type: "memo" | "document";
  topicId: string | null;
  title: string;
  body: string;
  timestamp: number;
  /**
   * Ids of the linked items on the other side of `source_links`. The caller
   * passes **only active ones** — trashed and hard-deleted ids must not be
   * exposed through search results.
   */
  sourceIds: readonly string[];
}>;

type EntryRow = { rowid: number; title: string; body: string };

function findEntry(sql: Sql, id: string): EntryRow | null {
  return one<EntryRow>(
    sql,
    "SELECT rowid, title, body FROM search_entries WHERE id = ?",
    id,
  );
}

function subtract(sql: Sql, entry: EntryRow): void {
  run(
    sql,
    "INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', ?, ?, ?)",
    entry.rowid,
    entry.title,
    entry.body,
  );
}

/** Creates or replaces the projection of one item. */
export function upsertSearchEntry(sql: Sql, row: SearchProjectionRow): void {
  const title = normalizeForIndex(row.title);
  const body = normalizeForIndex(row.body);

  const existing = findEntry(sql, row.id);
  if (existing !== null) {
    subtract(sql, existing);
  }

  const written = one<{ rowid: number }>(
    sql,
    `INSERT INTO search_entries (id, type, topic_id, title, body, timestamp, source_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       topic_id = excluded.topic_id,
       title = excluded.title,
       body = excluded.body,
       timestamp = excluded.timestamp,
       source_ids = excluded.source_ids
     RETURNING rowid`,
    row.id,
    row.type,
    row.topicId,
    title,
    body,
    row.timestamp,
    JSON.stringify(row.sourceIds),
  );

  run(
    sql,
    "INSERT INTO search_fts(rowid, title, body) VALUES (?, ?, ?)",
    written?.rowid ?? 0,
    title,
    body,
  );
}

/** Removes the projection of one item. Used for soft and hard delete alike. */
export function removeSearchEntry(sql: Sql, id: string): void {
  const existing = findEntry(sql, id);
  if (existing === null) return;
  subtract(sql, existing);
  run(sql, "DELETE FROM search_entries WHERE id = ?", id);
}

/**
 * Re-inserts the FTS side for one already-projected item **without**
 * subtracting first. This is the chunked-`reindex` primitive: it assumes the
 * index side was emptied beforehand, so calling it on a live index would
 * double-index the item.
 */
export function rebuildSearchEntry(sql: Sql, id: string): void {
  const entry = findEntry(sql, id);
  if (entry === null) return;
  run(
    sql,
    "INSERT INTO search_fts(rowid, title, body) VALUES (?, ?, ?)",
    entry.rowid,
    entry.title,
    entry.body,
  );
}
