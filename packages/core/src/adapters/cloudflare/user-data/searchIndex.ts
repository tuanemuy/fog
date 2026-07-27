import {
  ConflictError,
  NotFoundError,
  SystemError,
  SystemErrorCode,
  ValidationError,
} from "@repo/core/application/errors";
import type {
  DocumentSearchResultItem,
  LegacySearchPage,
  LegacySearchQuery,
  MemoSearchResultItem,
  SearchIndexPort,
  SearchPage,
  SearchProjectionOperation,
  SearchProjectionPort,
  SearchQuery,
  SearchResultItem,
} from "@repo/core/application/search/contracts";
import { SearchErrorCode } from "@repo/core/application/search/contracts";
import { BusinessRuleError } from "@repo/core/domain/error";
import { type SqlStorage, sqliteErrorCode } from "../sql";
import { payloadDigest } from "./canonical";

const MAX_PATTERN_BYTES = 50;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_MATCHES_PER_SNAPSHOT = 5_000;
const SNAPSHOT_TTL_MS = 15 * 60_000;

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim();
}

function queryBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function matchLiteral(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function originalSnippet(title: string, body: string, keyword: string): string {
  const source = normalizeText(title).includes(keyword) ? title : body;
  const characters = [...source];
  const normalizedCharacters: string[] = [];
  const sourceIndex: number[] = [];
  for (let index = 0; index < characters.length; index += 1) {
    for (const normalized of characters[index].normalize("NFKC")) {
      normalizedCharacters.push(normalized);
      sourceIndex.push(index);
    }
  }
  const normalized = normalizedCharacters.join("");
  const matchStart = normalized.indexOf(keyword);
  if (matchStart < 0) {
    return escapeHtml(characters.slice(0, 120).join(""));
  }
  const matchEnd = matchStart + [...keyword].length - 1;
  const sourceStart = sourceIndex[matchStart] ?? 0;
  const sourceEnd = (sourceIndex[matchEnd] ?? sourceStart) + 1;
  const windowStart = Math.max(0, sourceStart - 40);
  const windowEnd = Math.min(characters.length, sourceEnd + 40);
  return `${windowStart > 0 ? "…" : ""}${escapeHtml(
    characters.slice(windowStart, sourceStart).join(""),
  )}<mark>${escapeHtml(
    characters.slice(sourceStart, sourceEnd).join(""),
  )}</mark>${escapeHtml(
    characters.slice(sourceEnd, windowEnd).join(""),
  )}${windowEnd < characters.length ? "…" : ""}`;
}

function translateSqlError(error: unknown): never {
  if (
    error instanceof BusinessRuleError ||
    error instanceof ValidationError ||
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof SystemError
  ) {
    throw error;
  }
  const code = sqliteErrorCode(error);
  if (code === "SQLITE_FULL") {
    throw new SystemError(
      SystemErrorCode.StorageCapacityExceeded,
      "User data storage capacity was exceeded",
      error,
    );
  }
  throw new SystemError(
    SystemErrorCode.DatabaseError,
    "Search storage operation failed",
    error,
  );
}

type SearchRow = {
  id: string;
  kind: "memo" | "document";
  title: string;
  body: string;
  score: number;
  updated_at: number;
  topic_id: string | null;
  topic_name: string | null;
  topic_archived: number | null;
};

type SnapshotCursor = Readonly<{
  snapshotId: string;
  offset: number;
  queryDigest: string;
}>;

function encodeCursor(value: SnapshotCursor): string {
  return `${value.snapshotId}.${value.offset}.${value.queryDigest}`;
}

function decodeCursor(value: string): SnapshotCursor {
  const match = /^([0-9a-f-]{36})\.([0-9]+)\.(fnv1a64:[0-9a-f]{16})$/u.exec(
    value,
  );
  const offset = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isSafeInteger(offset) || offset < 0) {
    throw new ValidationError(
      SearchErrorCode.InvalidCursor,
      "Search cursor is invalid",
    );
  }
  return { snapshotId: match[1], offset, queryDigest: match[3] };
}

export class Fts5SearchAdapter
  implements SearchIndexPort, SearchProjectionPort
{
  constructor(private readonly sql: SqlStorage) {}

  apply(operation: SearchProjectionOperation): void {
    try {
      const id =
        operation.type === "remove" ? operation.id : operation.entry.id;
      const kind =
        operation.type === "remove"
          ? operation.entityType
          : operation.entry.type;
      const existing = this.sql
        .exec<{ rowid: number; title: string; body: string }>(
          `SELECT rowid, title, body FROM search_entries
           WHERE entity_type = ? AND entity_id = ?`,
          kind,
          id,
        )
        .toArray()[0];
      if (existing) {
        this.sql.exec(
          `INSERT INTO search_fts(search_fts, rowid, title, body)
           VALUES ('delete', ?, ?, ?)`,
          existing.rowid,
          existing.title,
          existing.body,
        );
        this.sql.exec(
          "DELETE FROM search_entries WHERE rowid = ?",
          existing.rowid,
        );
      }
      if (operation.type === "remove") return;
      const entry = operation.entry;
      const title = normalizeText(entry.type === "document" ? entry.title : "");
      const body = normalizeText(entry.body);
      const row = this.sql
        .exec<{ rowid: number }>(
          `INSERT INTO search_entries(
             entity_type, entity_id, title, body, timestamp, topic_id
           ) VALUES (?, ?, ?, ?, ?, ?) RETURNING rowid`,
          entry.type,
          entry.id,
          title,
          body,
          entry.timestamp,
          entry.type === "document" ? entry.topicId : null,
        )
        .one();
      this.sql.exec(
        "INSERT INTO search_fts(rowid, title, body) VALUES (?, ?, ?)",
        row.rowid,
        title,
        body,
      );
    } catch (error) {
      translateSqlError(error);
    }
  }

  query(query: SearchQuery): SearchPage {
    try {
      return this.queryUnchecked(query);
    } catch (error) {
      translateSqlError(error);
    }
  }

  search(query: LegacySearchQuery): LegacySearchPage {
    const page = this.query({
      keyword: query.text,
      ...(query.topicId === undefined ? {} : { topicId: query.topicId }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      page:
        query.offset === undefined || query.limit === undefined
          ? 1
          : Math.floor(query.offset / query.limit) + 1,
    });
    return {
      items: page.items.map((item) =>
        item.type === "memo"
          ? {
              id: item.id,
              kind: "memo" as const,
              title: "",
              snippet: item.snippet,
              score: 0,
              topicArchived: false,
              sourceLinks: [],
            }
          : {
              id: item.id,
              kind: "document" as const,
              title: item.title,
              snippet: item.snippet,
              score: 0,
              topicId: item.topic.id,
              topicArchived: item.topic.archived,
              sourceLinks: this.legacySourceLinks(item.id),
            },
      ),
      ...(page.nextCursor === null
        ? {}
        : {
            nextOffset: (query.offset ?? 0) + (query.limit ?? DEFAULT_LIMIT),
          }),
    };
  }

  private queryUnchecked(query: SearchQuery): SearchPage {
    const keyword = normalizeText(query.keyword);
    if (keyword.length === 0) {
      throw new BusinessRuleError(
        SearchErrorCode.EmptyKeyword,
        "Search keyword must not be empty",
      );
    }
    if (queryBytes(keyword) > MAX_PATTERN_BYTES) {
      throw new BusinessRuleError(
        SearchErrorCode.KeywordTooLong,
        "Search keyword must be at most 50 UTF-8 bytes",
      );
    }
    const limit = query.limit ?? DEFAULT_LIMIT;
    const page = query.page ?? 1;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_LIMIT ||
      !Number.isSafeInteger(page) ||
      page < 1
    ) {
      throw new ValidationError(
        SearchErrorCode.InvalidPagination,
        "Search page and limit are invalid",
      );
    }
    if (query.topicId !== undefined) this.assertTopic(query.topicId);
    const digest = payloadDigest({
      keyword,
      topicId: query.topicId ?? null,
    });
    this.pruneSnapshots(Date.now());
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      if (cursor.queryDigest !== digest) {
        throw new ValidationError(
          SearchErrorCode.InvalidCursor,
          "Search cursor does not match the query",
        );
      }
      return this.readSnapshot(cursor, limit);
    }
    const rows = this.findRows(keyword, query.topicId);
    if (rows.length > MAX_MATCHES_PER_SNAPSHOT) {
      throw new BusinessRuleError(
        SearchErrorCode.QueryTooComplex,
        "Search result set exceeds the snapshot limit",
      );
    }
    const items = this.toItems(rows, keyword);
    const offset = (page - 1) * limit;
    const snapshotId = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO search_snapshots(
         id, query_digest, total_count, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?)`,
      snapshotId,
      digest,
      items.length,
      now,
      now + SNAPSHOT_TTL_MS,
    );
    for (let start = 0; start < items.length; start += 100) {
      const batch = items.slice(start, start + 100);
      const values = batch.map(() => "(?, ?, ?)").join(", ");
      const bindings = batch.flatMap((item, index) => [
        snapshotId,
        start + index,
        JSON.stringify(item),
      ]);
      this.sql.exec(
        `INSERT INTO search_snapshot_items(snapshot_id, ordinal, item_json)
         VALUES ${values}`,
        ...bindings,
      );
    }
    return this.snapshotPage(snapshotId, digest, offset, limit, items.length);
  }

  private legacySourceLinks(
    contentId: string,
  ): readonly Readonly<{ memoId: string; label: string }>[] {
    return this.sql
      .exec<{ memo_id: string; label: string }>(
        `SELECT memo_id, label FROM content_sources
         WHERE content_id = ? ORDER BY memo_id`,
        contentId,
      )
      .toArray()
      .map((row) => ({ memoId: row.memo_id, label: row.label }));
  }

  private assertTopic(topicId: string): void {
    const topic = this.sql
      .exec<{ id: string }>(
        "SELECT id FROM topics WHERE id = ? AND trashed_at IS NULL",
        topicId,
      )
      .toArray()[0];
    if (!topic) {
      throw new NotFoundError(
        SearchErrorCode.TopicNotFound,
        "Topic was not found",
      );
    }
  }

  private findRows(keyword: string, topicId?: string): readonly SearchRow[] {
    const longQuery = [...keyword].length >= 3;
    const predicate = longQuery
      ? "search_fts MATCH ?"
      : "(instr(e.title, ?) > 0 OR instr(e.body, ?) > 0)";
    const bindings: unknown[] = longQuery
      ? [matchLiteral(keyword)]
      : [keyword, keyword];
    bindings.push(
      topicId ?? null,
      topicId ?? null,
      topicId ?? null,
      topicId ?? null,
      MAX_MATCHES_PER_SNAPSHOT + 1,
    );
    return this.sql
      .exec<SearchRow>(
        `SELECT c.id, c.kind, c.title, c.body,
                ${longQuery ? "bm25(search_fts, 3.0, 1.0)" : "0.0"} AS score,
                c.updated_at, c.topic_id, t.name AS topic_name,
                CASE WHEN t.archived_at IS NULL THEN 0 ELSE 1 END AS topic_archived
         FROM search_fts
         JOIN search_entries e ON e.rowid = search_fts.rowid
         JOIN content c ON c.id = e.entity_id AND c.kind = e.entity_type
         LEFT JOIN topics t ON t.id = c.topic_id
         WHERE ${predicate}
           AND c.trashed_at IS NULL
           AND (c.kind = 'memo' OR (t.id IS NOT NULL AND t.trashed_at IS NULL))
           AND (
             ? IS NULL
             OR (c.kind = 'document' AND c.topic_id = ?)
             OR (
               c.kind = 'memo'
               AND EXISTS (
                 SELECT 1 FROM content_sources cs
                 JOIN content d ON d.id = cs.content_id
                 JOIN topics dt ON dt.id = d.topic_id
                 WHERE cs.memo_id = c.id AND d.topic_id = ?
                   AND d.trashed_at IS NULL AND dt.trashed_at IS NULL
               )
             )
             OR (
               c.kind = 'memo'
               AND EXISTS (
                 SELECT 1 FROM topics st
                 WHERE st.id = ? AND st.source_memo_id = c.id
                   AND st.trashed_at IS NULL
               )
             )
           )
         ORDER BY score ASC, c.updated_at DESC, c.kind ASC, c.id ASC
         LIMIT ?`,
        ...bindings,
      )
      .toArray();
  }

  private toItems(
    rows: readonly SearchRow[],
    keyword: string,
  ): readonly SearchResultItem[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    const links = this.sql
      .exec<{ content_id: string; memo_id: string }>(
        `SELECT cs.content_id, cs.memo_id
         FROM content_sources cs
         JOIN content d ON d.id = cs.content_id AND d.trashed_at IS NULL
         JOIN content m ON m.id = cs.memo_id AND m.trashed_at IS NULL
         WHERE cs.content_id IN (${placeholders})
            OR cs.memo_id IN (${placeholders})
         ORDER BY cs.content_id, cs.memo_id`,
        ...ids,
        ...ids,
      )
      .toArray();
    const documentSources = new Map<string, string[]>();
    const memoDocuments = new Map<string, string[]>();
    for (const link of links) {
      const sourceIds = documentSources.get(link.content_id) ?? [];
      sourceIds.push(link.memo_id);
      documentSources.set(link.content_id, sourceIds);
      const documentIds = memoDocuments.get(link.memo_id) ?? [];
      documentIds.push(link.content_id);
      memoDocuments.set(link.memo_id, documentIds);
    }
    return rows.map((row): SearchResultItem => {
      const timestamp = new Date(row.updated_at).toISOString();
      const snippet = originalSnippet(row.title, row.body, keyword);
      if (row.kind === "memo") {
        return {
          type: "memo",
          id: row.id,
          snippet,
          timestamp,
          sourceOfDocumentIds: memoDocuments.get(row.id) ?? [],
        } satisfies MemoSearchResultItem;
      }
      if (row.topic_id === null || row.topic_name === null) {
        throw new ConflictError(
          "SEARCH_PROJECTION_INTEGRITY",
          "Document search projection has no active topic",
        );
      }
      return {
        type: "document",
        id: row.id,
        title: row.title,
        snippet,
        timestamp,
        topic: {
          id: row.topic_id,
          name: row.topic_name,
          archived: row.topic_archived === 1,
        },
        sourceMemoIds: documentSources.get(row.id) ?? [],
      } satisfies DocumentSearchResultItem;
    });
  }

  private readSnapshot(cursor: SnapshotCursor, limit: number): SearchPage {
    const row = this.sql
      .exec<{ total_count: number; expires_at: number }>(
        `SELECT total_count, expires_at FROM search_snapshots
         WHERE id = ? AND query_digest = ?`,
        cursor.snapshotId,
        cursor.queryDigest,
      )
      .toArray()[0];
    if (!row || row.expires_at <= Date.now()) {
      throw new ValidationError(
        SearchErrorCode.InvalidCursor,
        "Search cursor is invalid or expired",
      );
    }
    return this.snapshotPage(
      cursor.snapshotId,
      cursor.queryDigest,
      cursor.offset,
      limit,
      row.total_count,
    );
  }

  private snapshotPage(
    snapshotId: string,
    digest: string,
    offset: number,
    limit: number,
    totalCount: number,
  ): SearchPage {
    const items = this.sql
      .exec<{ item_json: string }>(
        `SELECT item_json FROM search_snapshot_items
         WHERE snapshot_id = ? AND ordinal >= ?
         ORDER BY ordinal LIMIT ?`,
        snapshotId,
        offset,
        limit,
      )
      .toArray()
      .map((row) => JSON.parse(row.item_json) as SearchResultItem);
    const nextOffset = offset + items.length;
    return {
      items,
      page: Math.floor(offset / limit) + 1,
      limit,
      totalCount,
      nextCursor:
        nextOffset < totalCount
          ? encodeCursor({
              snapshotId,
              offset: nextOffset,
              queryDigest: digest,
            })
          : null,
    };
  }

  private pruneSnapshots(now: number): void {
    this.sql.exec("DELETE FROM search_snapshots WHERE expires_at <= ?", now);
  }
}
