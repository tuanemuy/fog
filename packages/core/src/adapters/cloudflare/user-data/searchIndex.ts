import {
  ConflictError,
  NotFoundError,
  SystemError,
  SystemErrorCode,
  ValidationError,
} from "@repo/core/application/errors";
import type {
  DocumentSearchResultItem,
  MemoSearchResultItem,
  SearchIndexPort,
  SearchPage,
  SearchProjectionEntry,
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
const SNAPSHOT_INSERT_BATCH = 33;
const SOURCE_QUERY_BATCH = 50;
const MAX_ACTIVE_SNAPSHOTS = 8;
const MAX_SNAPSHOT_ITEMS = 5_000;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATE_SOURCE_BYTES = 4 * 1024 * 1024;

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
  const characters = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      source,
    ),
  ].map(({ segment }) => segment);
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
  limit: number;
  queryDigest: string;
}>;

function encodeCursor(value: SnapshotCursor): string {
  return `${value.snapshotId}.${value.offset}.${value.limit}.${value.queryDigest}`;
}

function decodeCursor(value: string): SnapshotCursor {
  const match =
    /^([0-9a-f-]{36})\.([0-9]+)\.([0-9]+)\.(sha256:[0-9a-f]{64})$/u.exec(value);
  const offset = match ? Number(match[2]) : Number.NaN;
  const limit = match ? Number(match[3]) : Number.NaN;
  if (
    !match ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT
  ) {
    throw new ValidationError(
      SearchErrorCode.InvalidCursor,
      "Search cursor is invalid",
    );
  }
  return {
    snapshotId: match[1],
    offset,
    limit,
    queryDigest: match[4],
  };
}

export class Fts5SearchAdapter
  implements SearchIndexPort, SearchProjectionPort
{
  constructor(private readonly sql: SqlStorage) {}

  upsert(entry: SearchProjectionEntry): void {
    this.replace(entry.type, entry.id, entry);
  }

  remove(entityType: "memo" | "document", id: string): void {
    this.replace(entityType, id);
  }

  private replace(
    kind: "memo" | "document",
    id: string,
    entry?: SearchProjectionEntry,
  ): void {
    try {
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
      if (entry === undefined) return;
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

  async query(query: SearchQuery): Promise<SearchPage> {
    return this.querySync(query);
  }

  querySync(query: SearchQuery): SearchPage {
    try {
      return this.queryUnchecked(query);
    } catch (error) {
      translateSqlError(error);
    }
  }

  private queryUnchecked(query: SearchQuery): SearchPage {
    const pagination = query.pagination ?? {};
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
    const limit = pagination.limit ?? DEFAULT_LIMIT;
    const page = pagination.page ?? 1;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_LIMIT ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      (pagination.cursor !== undefined && pagination.page !== undefined)
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
      limit,
    });
    this.pruneSnapshots(Date.now());
    if (pagination.cursor !== undefined) {
      const cursor = decodeCursor(pagination.cursor);
      if (cursor.queryDigest !== digest || cursor.limit !== limit) {
        throw new ValidationError(
          SearchErrorCode.InvalidCursor,
          "Search cursor does not match the query",
        );
      }
      return this.readSnapshot(cursor);
    }
    const candidates = this.findCandidateBudget(keyword, query.topicId);
    if (
      candidates.length > MAX_MATCHES_PER_SNAPSHOT ||
      candidates.reduce((total, row) => total + row.source_bytes, 0) >
        MAX_CANDIDATE_SOURCE_BYTES
    ) {
      throw new BusinessRuleError(
        SearchErrorCode.QueryTooComplex,
        "Search result set exceeds the materialization limit",
      );
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
    if (!Number.isSafeInteger(offset)) {
      throw new ValidationError(
        SearchErrorCode.InvalidPagination,
        "Search page offset is invalid",
      );
    }
    const pageItems = items.slice(offset, offset + limit);
    if (offset + pageItems.length >= items.length) {
      return {
        items: pageItems,
        page,
        limit,
        totalCount: items.length,
        nextCursor: null,
      };
    }
    const snapshotId = crypto.randomUUID();
    const now = Date.now();
    const itemJson = items.map((item) => JSON.stringify(item));
    const snapshotBytes = itemJson.reduce(
      (total, item) => total + queryBytes(item),
      0,
    );
    this.pruneSnapshotQuota(items.length, snapshotBytes);
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
    for (
      let start = 0;
      start < itemJson.length;
      start += SNAPSHOT_INSERT_BATCH
    ) {
      const batch = itemJson.slice(start, start + SNAPSHOT_INSERT_BATCH);
      const values = batch.map(() => "(?, ?, ?)").join(", ");
      const bindings = batch.flatMap((item, index) => [
        snapshotId,
        start + index,
        item,
      ]);
      this.sql.exec(
        `INSERT INTO search_snapshot_items(snapshot_id, ordinal, item_json)
         VALUES ${values}`,
        ...bindings,
      );
    }
    return this.snapshotPage(snapshotId, digest, offset, limit, items.length);
  }

  private findCandidateBudget(
    keyword: string,
    topicId?: string,
  ): readonly { source_bytes: number }[] {
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
      .exec<{ source_bytes: number }>(
        `SELECT length(CAST(c.title AS BLOB)) +
                length(CAST(c.body AS BLOB)) AS source_bytes
         FROM search_fts
         JOIN search_entries e ON e.rowid = search_fts.rowid
         JOIN content c ON c.id = e.entity_id AND c.kind = e.entity_type
         LEFT JOIN topics t ON t.id = c.topic_id
         WHERE ${predicate}
           AND c.trashed_at IS NULL
           AND c.trashed_with_topic_id IS NULL
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
                   AND d.trashed_at IS NULL
                   AND d.trashed_with_topic_id IS NULL
                   AND dt.trashed_at IS NULL
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
         LIMIT ?`,
        ...bindings,
      )
      .toArray();
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
           AND c.trashed_with_topic_id IS NULL
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
                   AND d.trashed_at IS NULL
                   AND d.trashed_with_topic_id IS NULL
                   AND dt.trashed_at IS NULL
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
    const links: Array<{ content_id: string; memo_id: string }> = [];
    for (let start = 0; start < ids.length; start += SOURCE_QUERY_BATCH) {
      const batch = ids.slice(start, start + SOURCE_QUERY_BATCH);
      const placeholders = batch.map(() => "?").join(", ");
      links.push(
        ...this.sql
          .exec<{ content_id: string; memo_id: string }>(
            `SELECT cs.content_id, cs.memo_id
             FROM content_sources cs
             JOIN content d ON d.id = cs.content_id
               AND d.trashed_at IS NULL
               AND d.trashed_with_topic_id IS NULL
             JOIN topics t ON t.id = d.topic_id AND t.trashed_at IS NULL
             JOIN content m ON m.id = cs.memo_id AND m.trashed_at IS NULL
             WHERE cs.content_id IN (${placeholders})
                OR cs.memo_id IN (${placeholders})
             ORDER BY cs.content_id, cs.memo_id`,
            ...batch,
            ...batch,
          )
          .toArray(),
      );
    }
    const documentSources = new Map<string, Set<string>>();
    const memoDocuments = new Map<string, Set<string>>();
    for (const link of links) {
      const sourceIds = documentSources.get(link.content_id) ?? new Set();
      sourceIds.add(link.memo_id);
      documentSources.set(link.content_id, sourceIds);
      const documentIds = memoDocuments.get(link.memo_id) ?? new Set();
      documentIds.add(link.content_id);
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
          sourceOfDocumentIds: [...(memoDocuments.get(row.id) ?? [])].sort(),
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
        sourceMemoIds: [...(documentSources.get(row.id) ?? [])].sort(),
      } satisfies DocumentSearchResultItem;
    });
  }

  private readSnapshot(cursor: SnapshotCursor): SearchPage {
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
      cursor.limit,
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
              limit,
              queryDigest: digest,
            })
          : null,
    };
  }

  private pruneSnapshots(now: number): void {
    this.sql.exec("DELETE FROM search_snapshots WHERE expires_at <= ?", now);
  }

  private pruneSnapshotQuota(itemCount: number, byteCount: number): void {
    if (itemCount > MAX_SNAPSHOT_ITEMS || byteCount > MAX_SNAPSHOT_BYTES) {
      throw new BusinessRuleError(
        SearchErrorCode.QueryTooComplex,
        "Search snapshot exceeds the storage quota",
      );
    }
    while (true) {
      const usage = this.sql
        .exec<{
          snapshot_count: number;
          item_count: number;
          byte_count: number;
        }>(
          `SELECT COUNT(DISTINCT s.id) AS snapshot_count,
                  COUNT(i.ordinal) AS item_count,
                  COALESCE(SUM(length(CAST(i.item_json AS BLOB))), 0) AS byte_count
           FROM search_snapshots s
           LEFT JOIN search_snapshot_items i ON i.snapshot_id = s.id`,
        )
        .one();
      if (
        usage.snapshot_count < MAX_ACTIVE_SNAPSHOTS &&
        usage.item_count + itemCount <= MAX_SNAPSHOT_ITEMS &&
        usage.byte_count + byteCount <= MAX_SNAPSHOT_BYTES
      ) {
        return;
      }
      const oldest = this.sql
        .exec<{ id: string }>(
          "SELECT id FROM search_snapshots ORDER BY created_at, id LIMIT 1",
        )
        .toArray()[0];
      if (!oldest) return;
      this.sql.exec("DELETE FROM search_snapshots WHERE id = ?", oldest.id);
    }
  }
}
