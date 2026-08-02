import { all, type Sql } from "../sql/exec";
import { normalizeForIndex } from "./normalize";

/**
 * The **minimum** read needed to verify the tokenizer in the real runtime. It
 * is not `SearchIndexPort`: ranking policy, snippets and the opaque-cursor
 * snapshot are #10's, and building them here would duplicate that work.
 *
 * #10 either absorbs these two functions into its `SearchIndexPort`
 * implementation or deletes them.
 *
 * Two paths, because `tokenize='trigram'` cannot index a sequence shorter than
 * three characters: a 1–2 character query matches **nothing** through `MATCH`
 * (measured), so it falls back to `instr()`. `LIKE` / `GLOB` are deliberately
 * not used — `instr()` is the one that was measured, and it carries no pattern
 * length limit.
 */

export const MIN_FTS_KEYWORD_LENGTH = 3;

export type ProbeHit = Readonly<{
  id: string;
  type: string;
  timestamp: number;
}>;

export function matchFts(
  sql: Sql,
  keyword: string,
  limit: number,
  offset = 0,
): ProbeHit[] {
  return all<{ id: string; type: string; timestamp: number }>(
    sql,
    `SELECT e.id AS id, e.type AS type, e.timestamp AS timestamp
       FROM search_fts f
       JOIN search_entries e ON e.rowid = f.rowid
      WHERE search_fts MATCH ?
      ORDER BY bm25(search_fts, 3.0, 1.0), e.timestamp DESC, e.id
      LIMIT ? OFFSET ?`,
    normalizeForIndex(keyword),
    limit,
    offset,
  );
}

export function matchShortKeyword(
  sql: Sql,
  keyword: string,
  limit: number,
  offset = 0,
): ProbeHit[] {
  const normalized = normalizeForIndex(keyword);
  return all<{ id: string; type: string; timestamp: number }>(
    sql,
    `SELECT id, type, timestamp
       FROM search_entries
      WHERE instr(title, ?) > 0 OR instr(body, ?) > 0
      ORDER BY timestamp DESC, type, id
      LIMIT ? OFFSET ?`,
    normalized,
    normalized,
    limit,
    offset,
  );
}
