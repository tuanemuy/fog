import {
  NotFoundError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import { codePointLength } from "@repo/core/domain/common/text";
import { BusinessRuleError } from "@repo/core/domain/error";
import type {
  DocumentId,
  TopicId,
} from "@repo/core/domain/knowledge/valueObject";
import type { MemoId } from "@repo/core/domain/memo/valueObject";
import { SearchErrorCode } from "@repo/core/domain/search/errorCode";
import type { SearchIndexPort } from "@repo/core/domain/search/ports/searchIndexPort";
import type {
  SearchPage,
  SearchQuery,
  SearchResultItem,
} from "@repo/core/domain/search/valueObject";
import { placeholders } from "./bindChunks";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  type SearchSnapshotKey,
} from "./searchCursor";
import { normalizeForSearch } from "./searchProjection";
import { buildSnippet } from "./searchSnippet";

/**
 * The largest set one search freezes. Past it the remaining matches are
 * not readable (decision △-3 of PH-04): the set rides inside the cursor,
 * and this keeps that cursor under ~12 KB.
 */
export const SEARCH_SNAPSHOT_LIMIT = 500;

/** How long a snapshot stays readable from its first page (decision △-1). */
export const SEARCH_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

/** Below this the trigram index cannot answer and `instr()` scans instead. */
const TRIGRAM_MIN_CODE_POINTS = 3;

/** `bm25` weights: a title hit outranks the same hit in a body. */
const TITLE_WEIGHT = 3.0;
const BODY_WEIGHT = 1.0;

type KeyRow = Readonly<{ type: "memo" | "document"; id: string }>;
type EntryRow = Readonly<{ id: string; source_ids: string }>;
type MemoRow = Readonly<{ id: string; body: string; posted_at: number }>;
type DocumentRow = Readonly<{
  id: string;
  title: string;
  body: string;
  updated_at: number;
  topic_id: string;
}>;

function invalidCursor(): BusinessRuleError<SearchErrorCode> {
  return new BusinessRuleError<SearchErrorCode>(
    SearchErrorCode.InvalidCursor,
    "The search cursor is invalid or has expired",
  );
}

/** The whole keyword as one phrase: no operators, no prefix wildcard. */
function phraseOf(keyword: string): string {
  return `"${keyword.replace(/"/g, '""')}"`;
}

/** Documents of the topic, and memos an active document of the topic cites. */
const SCOPE_PREDICATE = `(
  (e.type = 'document' AND e.topic_id = ?)
  OR (e.type = 'memo' AND EXISTS (
    SELECT 1 FROM source_links sl JOIN documents d ON d.id = sl.document_id
    WHERE sl.memo_id = e.id AND d.topic_id = ? AND d.status = 'active'
  ))
)`;

export function createSearchIndex(
  sql: SqlStorage,
  nowMs: () => number,
): SearchIndexPort {
  function assertTopicReachable(topicId: TopicId): void {
    const row = sql
      .exec<{ id: string }>(
        "SELECT id FROM topics WHERE id = ? AND status IN ('active', 'archived')",
        topicId,
      )
      .toArray()[0];
    if (row === undefined) {
      throw new NotFoundError("TOPIC_NOT_FOUND", "The topic was not found");
    }
  }

  function rank(keyword: string, topicId: TopicId | null): SearchSnapshotKey[] {
    const scope = topicId === null ? "" : `AND ${SCOPE_PREDICATE}`;
    const scopeBinds = topicId === null ? [] : [topicId, topicId];
    try {
      if (codePointLength(keyword) >= TRIGRAM_MIN_CODE_POINTS) {
        return sql
          .exec<KeyRow>(
            `SELECT e.type AS type, e.id AS id
             FROM search_fts JOIN search_entries e ON e.rowid = search_fts.rowid
             WHERE search_fts MATCH ? ${scope}
             ORDER BY bm25(search_fts, ?, ?), e.timestamp DESC, e.type, e.id
             LIMIT ?`,
            phraseOf(keyword),
            ...scopeBinds,
            TITLE_WEIGHT,
            BODY_WEIGHT,
            SEARCH_SNAPSHOT_LIMIT,
          )
          .toArray();
      }
      // Below the trigram width: an unindexed scan over the two text columns,
      // bounded by the snapshot limit (`spec/database/index.md`).
      return sql
        .exec<KeyRow>(
          `SELECT e.type AS type, e.id AS id FROM search_entries e
           WHERE (instr(e.title, ?) > 0 OR instr(e.body, ?) > 0) ${scope}
           ORDER BY e.timestamp DESC, e.type, e.id
           LIMIT ?`,
          keyword,
          keyword,
          ...scopeBinds,
          SEARCH_SNAPSHOT_LIMIT,
        )
        .toArray();
    } catch (error) {
      throw new SystemError(
        SystemErrorCode.SearchIndexUnavailable,
        "The search index could not answer the query",
        error,
      );
    }
  }

  function loadPage(
    keys: readonly SearchSnapshotKey[],
    keyword: string,
  ): SearchResultItem[] {
    if (keys.length === 0) return [];
    const ids = keys.map((key) => key.id);
    const sourceIds = new Map<string, string[]>();
    for (const row of sql
      .exec<EntryRow>(
        `SELECT id, source_ids FROM search_entries WHERE id IN (${placeholders(ids.length)})`,
        ...ids,
      )
      .toArray()) {
      sourceIds.set(row.id, JSON.parse(row.source_ids) as string[]);
    }
    const memoIds = keys.filter((k) => k.type === "memo").map((k) => k.id);
    const documentIds = keys
      .filter((k) => k.type === "document")
      .map((k) => k.id);
    const memos = new Map<string, MemoRow>();
    if (memoIds.length > 0) {
      for (const row of sql
        .exec<MemoRow>(
          `SELECT id, body, posted_at FROM memos
           WHERE status = 'active' AND id IN (${placeholders(memoIds.length)})`,
          ...memoIds,
        )
        .toArray()) {
        memos.set(row.id, row);
      }
    }
    const documents = new Map<string, DocumentRow>();
    if (documentIds.length > 0) {
      for (const row of sql
        .exec<DocumentRow>(
          `SELECT id, title, body, updated_at, topic_id FROM documents
           WHERE status = 'active' AND id IN (${placeholders(documentIds.length)})`,
          ...documentIds,
        )
        .toArray()) {
        documents.set(row.id, row);
      }
    }
    const items: SearchResultItem[] = [];
    for (const key of keys) {
      // A row trashed since the snapshot was taken has no entry any more:
      // the set stays fixed, the trash stays invisible.
      const sources = sourceIds.get(key.id);
      if (sources === undefined) continue;
      if (key.type === "memo") {
        const memo = memos.get(key.id);
        if (memo === undefined) continue;
        items.push({
          type: "memo",
          id: memo.id as MemoId,
          snippet: buildSnippet(memo.body, keyword),
          timestamp: new Date(memo.posted_at),
          sourceOfDocumentIds: sources as DocumentId[],
        });
      } else {
        const document = documents.get(key.id);
        if (document === undefined) continue;
        items.push({
          type: "document",
          id: document.id as DocumentId,
          snippet: buildSnippet(`${document.title}\n${document.body}`, keyword),
          timestamp: new Date(document.updated_at),
          topicId: document.topic_id as TopicId,
          sourceMemoIds: sources as MemoId[],
        });
      }
    }
    return items;
  }

  return {
    query(query: SearchQuery): SearchPage {
      const topicId = query.topicId ?? null;
      if (topicId !== null) assertTopicReachable(topicId);
      const keyword = normalizeForSearch(query.keyword);
      const now = nowMs();

      let set: readonly SearchSnapshotKey[];
      let offset: number;
      let expiresAt: number;
      if (query.cursor === undefined) {
        set = rank(keyword, topicId);
        offset = 0;
        expiresAt = now + SEARCH_SNAPSHOT_TTL_MS;
      } else {
        const payload = decodeSearchCursor(query.cursor);
        if (
          payload.expiresAt < now ||
          payload.keyword !== keyword ||
          payload.topicId !== topicId
        ) {
          throw invalidCursor();
        }
        set = payload.ids;
        offset = payload.offset;
        expiresAt = payload.expiresAt;
      }

      const end = Math.min(set.length, offset + query.limit);
      const items = loadPage(set.slice(offset, end), keyword);
      return {
        items,
        count: set.length,
        ...(end < set.length
          ? {
              nextCursor: encodeSearchCursor({
                keyword,
                topicId,
                expiresAt,
                offset: end,
                ids: set,
              }),
            }
          : {}),
      };
    },
  };
}
