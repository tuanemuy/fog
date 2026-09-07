/**
 * The search projection, maintained inside the writing repository's own
 * transaction. Not a port and never injectable: the atomicity of the
 * transaction it rides in is the only thing keeping the index true.
 *
 * `search_fts` is external-content FTS5, so an update is two steps — the
 * delete command with the **old** values, then the insert with the new ones.
 * A plain `DELETE FROM search_fts` would corrupt the index silently.
 */

type EntryRow = Readonly<{ rowid: number; title: string; body: string }>;

export type SearchEntry = Readonly<{
  id: string;
  type: "memo" | "document";
  topicId: string | null;
  title: string;
  body: string;
  timestamp: number;
  sourceIds: readonly string[];
}>;

/** NFKC + trim, applied on the index side and the query side alike. */
export function normalizeForSearch(value: string): string {
  return value.normalize("NFKC").trim();
}

export function removeSearchEntry(sql: SqlStorage, id: string): void {
  const existing = sql
    .exec<EntryRow>(
      "SELECT rowid, title, body FROM search_entries WHERE id = ?",
      id,
    )
    .toArray()[0];
  if (!existing) return;
  sql.exec(
    "INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', ?, ?, ?)",
    existing.rowid,
    existing.title,
    existing.body,
  );
  sql.exec("DELETE FROM search_entries WHERE rowid = ?", existing.rowid);
}

/** Replaces the entry for `entry.id`, whatever it held before. */
export function upsertSearchEntry(sql: SqlStorage, entry: SearchEntry): void {
  removeSearchEntry(sql, entry.id);
  const title = normalizeForSearch(entry.title);
  const body = normalizeForSearch(entry.body);
  const inserted = sql
    .exec<{ rowid: number }>(
      `INSERT INTO search_entries (id, type, topic_id, title, body, timestamp, source_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING rowid`,
      entry.id,
      entry.type,
      entry.topicId,
      title,
      body,
      entry.timestamp,
      JSON.stringify(entry.sourceIds),
    )
    .one();
  sql.exec(
    "INSERT INTO search_fts(rowid, title, body) VALUES (?, ?, ?)",
    inserted.rowid,
    title,
    body,
  );
}

/** Active documents citing the memo — the only ids a memo entry may expose. */
export function activeSourceDocumentIds(
  sql: SqlStorage,
  memoId: string,
): string[] {
  return sql
    .exec<{ id: string }>(
      `SELECT d.id FROM source_links sl JOIN documents d ON d.id = sl.document_id
       WHERE sl.memo_id = ? AND d.status = 'active' ORDER BY d.id`,
      memoId,
    )
    .toArray()
    .map((row) => row.id);
}
