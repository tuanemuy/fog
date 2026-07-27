import type {
  SearchIndexPort,
  SearchPage,
  SearchProjectionOperation,
  SearchProjectionPort,
  SearchQuery,
  SearchSourceLink,
} from "@repo/core/application/search/contracts";
import type { SqlStorage } from "../sql";

const MAX_PATTERN_BYTES = 50;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim();
}

function queryBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function matchLiteral(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

type SearchRow = {
  id: string;
  kind: "memo" | "document";
  title: string;
  snippet: string;
  body: string;
  score: number;
  topic_id: string | null;
  topic_archived: number;
};

export class Fts5SearchAdapter
  implements SearchIndexPort, SearchProjectionPort
{
  constructor(private readonly sql: SqlStorage) {}

  apply(operation: SearchProjectionOperation): void {
    this.sql.exec(
      "DELETE FROM search_fts WHERE content_id = ?",
      operation.type === "remove" ? operation.id : operation.entry.id,
    );
    if (
      operation.type === "remove" ||
      operation.entry.trashedAt !== undefined
    ) {
      return;
    }
    this.sql.exec(
      `INSERT INTO search_fts(content_id, kind, title, body)
       VALUES (?, ?, ?, ?)`,
      operation.entry.id,
      operation.entry.kind,
      normalizeText(operation.entry.title),
      normalizeText(operation.entry.body),
    );
  }

  search(query: SearchQuery): SearchPage {
    const text = normalizeText(query.text);
    if (text.length === 0) return { items: [] };
    if (queryBytes(text) > MAX_PATTERN_BYTES) {
      throw new RangeError("Search pattern exceeds 50 UTF-8 bytes");
    }
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const offset = Math.max(query.offset ?? 0, 0);
    const topic = query.topicId ?? null;
    const includeTrash = query.includeTrash === true ? 1 : 0;
    const bindings: unknown[] = [];
    const predicate =
      [...text].length >= 3
        ? "search_fts MATCH ?"
        : "(instr(search_fts.title, ?) > 0 OR instr(search_fts.body, ?) > 0)";
    if ([...text].length >= 3) bindings.push(matchLiteral(text));
    else bindings.push(text, text);
    bindings.push(topic, topic, includeTrash, limit + 1, offset);
    const rows = this.sql
      .exec<SearchRow>(
        `SELECT c.id, c.kind, c.title, c.body,
                snippet(search_fts, 3, '<mark>', '</mark>', '…', 24) AS snippet,
                bm25(search_fts, 0.0, 0.0, 3.0, 1.0) AS score,
                c.topic_id, c.topic_archived
         FROM search_fts
         JOIN content c ON c.id = search_fts.content_id
         WHERE ${predicate}
           AND (? IS NULL OR c.topic_id = ?)
           AND (? = 1 OR c.trashed_at IS NULL)
         ORDER BY score ASC, c.id ASC
         LIMIT ? OFFSET ?`,
        ...bindings,
      )
      .toArray();
    const items = rows.slice(0, limit).map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      snippet:
        [...text].length >= 3
          ? row.snippet
          : row.body.replace(text, `<mark>${text}</mark>`),
      score: row.score,
      ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
      topicArchived: row.topic_archived === 1,
      sourceLinks: this.sources(row.id),
    }));
    return {
      items,
      ...(rows.length > limit ? { nextOffset: offset + limit } : {}),
    };
  }

  private sources(contentId: string): readonly SearchSourceLink[] {
    return this.sql
      .exec<{ memo_id: string; label: string }>(
        `SELECT memo_id, label FROM content_sources
         WHERE content_id = ? ORDER BY memo_id`,
        contentId,
      )
      .toArray()
      .map((row) => ({ memoId: row.memo_id, label: row.label }));
  }
}
