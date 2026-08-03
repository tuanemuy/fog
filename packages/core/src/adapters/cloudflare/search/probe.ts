import { all, type Sql } from "../sql/exec";
import { normalizeForIndex } from "./normalize";

/**
 * The **minimum** read needed to verify the tokenizer in the real runtime. It
 * is not `SearchIndexPort`: ranking policy, snippets and the opaque-cursor
 * snapshot belong to that port's implementation, which either absorbs these
 * two functions or deletes them.
 *
 * Two paths, because `tokenize='trigram'` cannot index a sequence shorter than
 * three characters: a 1–2 character query matches **nothing** through `MATCH`
 * (measured), so it falls back to `instr()`. `LIKE` / `GLOB` are deliberately
 * not used — `instr()` is the one that was measured, and it carries no pattern
 * length limit.
 */

export const MIN_FTS_KEYWORD_LENGTH = 3;

/**
 * A keyword as an FTS5 **phrase literal**.
 *
 * The right-hand side of `MATCH` is a query expression, not a string: `"`, `*`,
 * `:`, `^`, `(`, `)` and the bare words `AND` / `OR` / `NOT` / `NEAR` are all
 * operators, and an unbalanced quote is a syntax error that surfaces to the
 * user as a 500 on any search containing it. Binding the value as a parameter
 * does not help — it is still parsed as an expression once bound.
 *
 * Wrapping in double quotes (with any embedded quote doubled, as FTS5 escapes
 * them) makes the whole keyword one phrase. The trigram tokenizer indexes
 * punctuation, so symbols in a query are ordinary search terms rather than an
 * edge case, and matching is unchanged for keywords that contained no operator
 * to begin with.
 */
function asPhrase(keyword: string): string {
  return `"${keyword.replaceAll('"', '""')}"`;
}

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
    asPhrase(normalizeForIndex(keyword)),
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
