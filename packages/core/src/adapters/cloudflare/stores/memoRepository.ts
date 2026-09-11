import {
  fromBase64Url,
  toBase64Url,
} from "@repo/core/adapters/webcrypto/encoding";
import { ValidationError } from "@repo/core/application/errors";
import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import { RehydrationError } from "@repo/core/domain/error";
import {
  Actor,
  AiClientConnectionId,
  ClientName,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import type {
  ActiveMemo,
  Memo,
  MemoRevision,
  TrashedMemo,
} from "@repo/core/domain/memo/entity";
import type {
  MemoRepository,
  MemoRevisionSummary,
  TimelineAnchor,
  TimelinePage,
  TimelineQuery,
  TimelineWindow,
} from "@repo/core/domain/memo/ports/memoRepository";
import {
  MemoBody,
  MemoId,
  RevisionNumber,
  TimelineCursor,
} from "@repo/core/domain/memo/valueObject";
import { updateMatchedRow } from "../rowRunner";
import { bindChunks, placeholders } from "./bindChunks";
import { occConflict } from "./occ";
import {
  activeSourceDocumentIds,
  removeSearchEntry,
  reprojectCitingDocuments,
  upsertSearchEntry,
} from "./searchProjection";

type MemoRow = Readonly<{
  id: string;
  body: string;
  latest_revision_number: number;
  posted_at: number;
  status: "active" | "trashed";
  trashed_at: number | null;
  purge_after: number | null;
  version: number;
  updated_at: number;
}>;

type RevisionRow = Readonly<{
  memo_id: string;
  revision_number: number;
  actor_type: "user" | "ai_client";
  actor_connection_id: string | null;
  actor_client_name: string | null;
  body: string;
  created_at: number;
}>;

const MEMO_COLUMNS =
  "id, body, latest_revision_number, posted_at, status, trashed_at, purge_after, version, updated_at";

type CursorPayload = Readonly<{ p: number; i: string }>;

/**
 * `keyword` as a `LIKE` pattern: a substring match with `%` / `_` / `\`
 * in the keyword taken literally (`ESCAPE '\'`). `LIKE` folds ASCII case
 * and nothing else; no normalisation is applied to either side
 * (`spec/database/index.md`, keyword 絞り込み).
 */
export function keywordLikePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const KEYWORD_CLAUSE = "body LIKE ? ESCAPE '\\'";

/** `(posted_at, id)` as base64url JSON; undecodable is the transport's `ValidationError`. */
export function encodeTimelineCursor(
  postedAt: number,
  id: string,
): TimelineCursor {
  const payload: CursorPayload = { p: postedAt, i: id };
  return TimelineCursor.create(
    toBase64Url(new TextEncoder().encode(JSON.stringify(payload))),
  );
}

export function decodeTimelineCursor(cursor: TimelineCursor): CursorPayload {
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(fromBase64Url(cursor)),
    ) as Partial<CursorPayload>;
    if (
      typeof parsed.p === "number" &&
      Number.isFinite(parsed.p) &&
      typeof parsed.i === "string" &&
      parsed.i.length > 0
    ) {
      return { p: parsed.p, i: parsed.i };
    }
  } catch {
    // fall through to the single rejection below
  }
  throw new ValidationError("INVALID_CURSOR", "The timeline cursor is invalid");
}

function rehydrate(row: MemoRow, userId: UserId): Memo {
  try {
    const base = {
      id: MemoId.create(row.id),
      userId,
      body: MemoBody.create(row.body),
      latestRevisionNumber: RevisionNumber.create(row.latest_revision_number),
      postedAt: new Date(row.posted_at),
      version: row.version,
      updatedAt: new Date(row.updated_at),
    };
    if (row.status === "active") return { ...base, status: "active" };
    if (row.trashed_at === null || row.purge_after === null) {
      throw new RehydrationError(`memo ${row.id}: trashed without timestamps`);
    }
    return {
      ...base,
      status: "trashed",
      trashedAt: new Date(row.trashed_at),
      purgeAfter: new Date(row.purge_after),
    };
  } catch (cause) {
    throw new RehydrationError(`memo ${row.id} cannot be rehydrated`, cause);
  }
}

function rehydrateRevision(row: RevisionRow, userId: UserId): MemoRevision {
  try {
    return {
      memoId: MemoId.create(row.memo_id),
      revisionNumber: RevisionNumber.create(row.revision_number),
      actor:
        row.actor_type === "user"
          ? Actor.user(userId)
          : Actor.aiClient(
              userId,
              AiClientConnectionId.create(row.actor_connection_id ?? ""),
              ClientName.create(row.actor_client_name ?? ""),
            ),
      body: MemoBody.create(row.body),
      createdAt: new Date(row.created_at),
    };
  } catch (cause) {
    throw new RehydrationError(
      `memo revision ${row.memo_id}#${row.revision_number} cannot be rehydrated`,
      cause,
    );
  }
}

function versioned<T extends Memo>(entity: T, row: MemoRow): Versioned<T> {
  return { entity, expectedVersion: row.version as ExpectedVersion<T> };
}

function projectMemo(sql: SqlStorage, memo: Memo): void {
  if (memo.status !== "active") {
    removeSearchEntry(sql, memo.id);
    // The documents citing it drop its id from their entries (contract
    // 「メモのソフトデリート」 in `spec/domains/search.md`).
    reprojectCitingDocuments(sql, memo.id);
    return;
  }
  upsertSearchEntry(sql, {
    id: memo.id,
    type: "memo",
    topicId: null,
    title: "",
    body: memo.body,
    timestamp: memo.postedAt.getTime(),
    sourceIds: activeSourceDocumentIds(sql, memo.id),
  });
}

type PivotRow = Readonly<{ posted_at: number; id: string }>;

/**
 * The pivot reads of `findTimelineAround`: the memo anchor itself, and for
 * a date anchor the newest row before the day's end and the oldest row
 * from it. Exported so the plan test reads the statements the repository
 * runs (`__tests__/memoTimelinePlan.integration.test.ts`).
 */
export function pivotStatement(
  kind: "memo" | "before" | "after",
  keyword: boolean,
): string {
  const keywordClause = keyword ? ` AND ${KEYWORD_CLAUSE}` : "";
  switch (kind) {
    case "memo":
      return `SELECT posted_at, id FROM memos WHERE id = ? AND status = 'active'${keywordClause}`;
    case "before":
      return `SELECT posted_at, id FROM memos WHERE status = 'active' AND posted_at < ?${keywordClause}
       ORDER BY posted_at DESC, id DESC LIMIT 1`;
    case "after":
      return `SELECT posted_at, id FROM memos WHERE status = 'active' AND posted_at >= ?${keywordClause}
       ORDER BY posted_at ASC, id ASC LIMIT 1`;
  }
}

/**
 * One page of `findTimelinePage` / one half of `findTimelineAround`:
 * `positioned` continues from a `(posted_at, id)` cursor, `inclusive`
 * keeps the cursor row on the older side. Exported for the plan test.
 */
export function timelinePageStatement(shape: {
  positioned: boolean;
  direction: "older" | "newer";
  inclusive: boolean;
  keyword: boolean;
}): string {
  const conditions = ["status = 'active'"];
  if (shape.positioned) {
    // A row-value comparison, not the equivalent `a < ? OR (a = ? AND b < ?)`:
    // SQLite seeks `memos_timeline_idx` from the cursor for the former and
    // walks it from the newest row for the latter, so a deep page would
    // cost every row above it.
    const comparison =
      shape.direction === "older" ? (shape.inclusive ? "<=" : "<") : ">";
    conditions.push(`(posted_at, id) ${comparison} (?, ?)`);
  }
  if (shape.keyword) conditions.push(KEYWORD_CLAUSE);
  const order =
    shape.direction === "older"
      ? "posted_at DESC, id DESC"
      : "posted_at ASC, id ASC";
  return `SELECT ${MEMO_COLUMNS} FROM memos WHERE ${conditions.join(" AND ")}
         ORDER BY ${order} LIMIT ?`;
}

/**
 * The row the window is centred on. A memo anchor is the memo itself. A
 * date anchor is the newest memo of the day; for an empty day it is the
 * nearer of the newest memo before the day and the oldest memo after it,
 * each measured from its own edge of the day, the past winning a tie
 * (`spec/domains/memo.md`, findTimelineAround).
 */
function resolvePivot(
  sql: SqlStorage,
  anchor: TimelineAnchor,
  keyword: string | null,
): CursorPayload | null {
  const keywordBindings: SqlStorageValue[] =
    keyword === null ? [] : [keywordLikePattern(keyword)];
  const toPivot = (row: PivotRow | undefined): CursorPayload | null =>
    row ? { p: row.posted_at, i: row.id } : null;
  if (anchor.kind === "memo") {
    return toPivot(
      sql
        .exec<PivotRow>(
          pivotStatement("memo", keyword !== null),
          anchor.memoId,
          ...keywordBindings,
        )
        .toArray()[0],
    );
  }
  const from = anchor.from.getTime();
  const toExclusive = anchor.toExclusive.getTime();
  const before = sql
    .exec<PivotRow>(
      pivotStatement("before", keyword !== null),
      toExclusive,
      ...keywordBindings,
    )
    .toArray()[0];
  if (before && before.posted_at >= from) return toPivot(before);
  const after = sql
    .exec<PivotRow>(
      pivotStatement("after", keyword !== null),
      toExclusive,
      ...keywordBindings,
    )
    .toArray()[0];
  if (!before) return toPivot(after);
  if (!after) return toPivot(before);
  const pastDistance = toExclusive - before.posted_at;
  const futureDistance = after.posted_at - from;
  return toPivot(futureDistance < pastDistance ? after : before);
}

/**
 * `memos` + `memo_revisions`, with the search projection written in the same
 * statement sequence as the body. `userId` is the object's own identity, taken
 * from `_meta` by the caller and never used as a row predicate.
 */
export function createMemoRepository(
  sql: SqlStorage,
  selfUserId: string,
): MemoRepository {
  const userId = UserId.create(selfUserId);

  // `inclusive` keeps the pivot row itself in an "older" read: the window
  // around an anchor must contain the anchor.
  const timelinePage = (
    query: TimelineQuery,
    position: CursorPayload | null,
    direction: "older" | "newer",
    inclusive = false,
  ): { rows: MemoRow[]; hasMore: boolean } => {
    const bindings: SqlStorageValue[] = [];
    if (position !== null) bindings.push(position.p, position.i);
    if (query.keyword !== null) {
      bindings.push(keywordLikePattern(query.keyword));
    }
    const rows = sql
      .exec<MemoRow>(
        timelinePageStatement({
          positioned: position !== null,
          direction,
          inclusive,
          keyword: query.keyword !== null,
        }),
        ...bindings,
        query.limit + 1,
      )
      .toArray();
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return { rows: direction === "older" ? page : page.reverse(), hasMore };
  };

  return {
    insert(memo) {
      sql.exec(
        `INSERT INTO memos (${MEMO_COLUMNS}) VALUES (?, ?, ?, ?, 'active', NULL, NULL, ?, ?)`,
        memo.id,
        memo.body,
        memo.latestRevisionNumber,
        memo.postedAt.getTime(),
        memo.version,
        memo.updatedAt.getTime(),
      );
      projectMemo(sql, memo);
    },

    insertRevision(revision) {
      const actor = revision.actor;
      sql.exec(
        `INSERT INTO memo_revisions (memo_id, revision_number, actor_type, actor_connection_id, actor_client_name, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        revision.memoId,
        revision.revisionNumber,
        actor.kind === "user" ? "user" : "ai_client",
        actor.kind === "aiClient" ? actor.connectionId : null,
        actor.kind === "aiClient" ? actor.clientName : null,
        revision.body,
        revision.createdAt.getTime(),
      );
    },

    save(memo, expectedVersion) {
      // A restore (trashed → active) puts the id back into the citing
      // documents' entries; an edit changes nothing on their side.
      const previous = sql
        .exec<{ status: string }>(
          "SELECT status FROM memos WHERE id = ?",
          memo.id,
        )
        .toArray()[0]?.status;
      const matched = updateMatchedRow(
        sql,
        `UPDATE memos SET body = ?, latest_revision_number = ?, status = ?, trashed_at = ?, purge_after = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
        memo.body,
        memo.latestRevisionNumber,
        memo.status,
        memo.status === "trashed" ? memo.trashedAt.getTime() : null,
        memo.status === "trashed" ? memo.purgeAfter.getTime() : null,
        memo.version,
        memo.updatedAt.getTime(),
        memo.id,
        expectedVersion as number,
      );
      if (!matched) throw occConflict();
      projectMemo(sql, memo);
      if (previous === "trashed" && memo.status === "active") {
        reprojectCitingDocuments(sql, memo.id);
      }
    },

    hardDelete(id, expectedVersion) {
      const matched =
        sql
          .exec<{ matched: number }>(
            "DELETE FROM memos WHERE id = ? AND version = ? RETURNING 1 AS matched",
            id,
            expectedVersion as number,
          )
          .toArray().length > 0;
      if (!matched) throw occConflict();
      sql.exec("DELETE FROM memo_revisions WHERE memo_id = ?", id);
      removeSearchEntry(sql, id);
    },

    findById(id) {
      const row = sql
        .exec<MemoRow>(
          `SELECT ${MEMO_COLUMNS} FROM memos WHERE id = ? AND status = 'active'`,
          id,
        )
        .toArray()[0];
      if (!row) return null;
      const memo = rehydrate(row, userId);
      return memo.status === "active" ? versioned(memo, row) : null;
    },

    findByIdIncludingTrashed(id) {
      const row = sql
        .exec<MemoRow>(`SELECT ${MEMO_COLUMNS} FROM memos WHERE id = ?`, id)
        .toArray()[0];
      return row ? versioned(rehydrate(row, userId), row) : null;
    },

    listByIdsIncludingTrashed(ids) {
      const result: Memo[] = [];
      for (const chunk of bindChunks(ids)) {
        for (const row of sql
          .exec<MemoRow>(
            `SELECT ${MEMO_COLUMNS} FROM memos WHERE id IN (${placeholders(chunk.length)})`,
            ...chunk,
          )
          .toArray()) {
          result.push(rehydrate(row, userId));
        }
      }
      return result;
    },

    listActiveByIds(ids) {
      const result: Versioned<ActiveMemo>[] = [];
      for (const chunk of bindChunks(ids)) {
        for (const row of sql
          .exec<MemoRow>(
            `SELECT ${MEMO_COLUMNS} FROM memos WHERE status = 'active' AND id IN (${placeholders(chunk.length)})`,
            ...chunk,
          )
          .toArray()) {
          const memo = rehydrate(row, userId);
          if (memo.status === "active") result.push(versioned(memo, row));
        }
      }
      return result;
    },

    findTimelinePage(query): TimelinePage {
      const position =
        query.cursor === null ? null : decodeTimelineCursor(query.cursor);
      const { rows, hasMore } = timelinePage(query, position, query.direction);
      const items = rows.map((row) => rehydrate(row, userId) as ActiveMemo);
      const edge =
        query.direction === "older" ? rows[rows.length - 1] : rows[0];
      return {
        items,
        nextCursor:
          hasMore && edge
            ? encodeTimelineCursor(edge.posted_at, edge.id)
            : null,
      };
    },

    findTimelineAround(anchor, query): TimelineWindow {
      const pivot = resolvePivot(sql, anchor, query.keyword);
      if (pivot === null) {
        return {
          items: [],
          olderCursor: null,
          newerCursor: null,
          pivotId: null,
        };
      }
      // The pivot counts against `limit` on the older side, so the window
      // never exceeds `limit` rows: 1 → the pivot alone, 2 → one newer + it.
      const newerLimit = Math.floor(query.limit / 2);
      const olderLimit = query.limit - newerLimit;
      const older = timelinePage(
        {
          cursor: null,
          direction: "older",
          limit: olderLimit,
          keyword: query.keyword,
        },
        pivot,
        "older",
        true,
      );
      const newer = timelinePage(
        {
          cursor: null,
          direction: "newer",
          limit: newerLimit,
          keyword: query.keyword,
        },
        pivot,
        "newer",
        false,
      );
      const rows = [...newer.rows, ...older.rows];
      const oldest = older.rows[older.rows.length - 1];
      // An empty newer half (`limit: 1`) continues from the pivot itself.
      const newest = newer.rows[0] ?? { posted_at: pivot.p, id: pivot.i };
      return {
        pivotId: MemoId.create(pivot.i),
        items: rows.map((row) => rehydrate(row, userId) as ActiveMemo),
        olderCursor:
          older.hasMore && oldest
            ? encodeTimelineCursor(oldest.posted_at, oldest.id)
            : null,
        newerCursor: newer.hasMore
          ? encodeTimelineCursor(newest.posted_at, newest.id)
          : null,
      };
    },

    listRevisionSummaries(memoId): MemoRevisionSummary[] {
      return sql
        .exec<RevisionRow>(
          `SELECT memo_id, revision_number, actor_type, actor_connection_id, actor_client_name, '' AS body, created_at
           FROM memo_revisions WHERE memo_id = ? ORDER BY revision_number ASC`,
          memoId,
        )
        .toArray()
        .map((row) => {
          const revision = rehydrateRevision({ ...row, body: "-" }, userId);
          return {
            revisionNumber: revision.revisionNumber,
            actor: revision.actor,
            createdAt: revision.createdAt,
          };
        });
    },

    findRevision(memoId, revisionNumber) {
      const row = sql
        .exec<RevisionRow>(
          `SELECT memo_id, revision_number, actor_type, actor_connection_id, actor_client_name, body, created_at
           FROM memo_revisions WHERE memo_id = ? AND revision_number = ?`,
          memoId,
          revisionNumber,
        )
        .toArray()[0];
      return row ? rehydrateRevision(row, userId) : null;
    },

    listTrashed() {
      return sql
        .exec<MemoRow>(
          `SELECT ${MEMO_COLUMNS} FROM memos WHERE status = 'trashed' ORDER BY trashed_at DESC`,
        )
        .toArray()
        .map((row) => versioned(rehydrate(row, userId) as TrashedMemo, row));
    },

    recalculatePurgeAfter(retentionDays, limit) {
      const retentionMs = retentionDays * 86_400_000;
      const updated = sql
        .exec<{ matched: number }>(
          `UPDATE memos SET purge_after = trashed_at + ?
           WHERE id IN (
             SELECT id FROM memos WHERE status = 'trashed' AND purge_after <> trashed_at + ? LIMIT ?
           ) RETURNING 1 AS matched`,
          retentionMs,
          retentionMs,
          limit,
        )
        .toArray().length;
      const remaining = sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM memos WHERE status = 'trashed' AND purge_after <> trashed_at + ?",
          retentionMs,
        )
        .one().n;
      return { updatedCount: updated, hasMore: remaining > 0 };
    },
  };
}
