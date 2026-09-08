import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import { RehydrationError } from "@repo/core/domain/error";
import { UserId } from "@repo/core/domain/identity/valueObject";
import type {
  LiveTopic,
  Topic,
  TrashedTopic,
} from "@repo/core/domain/knowledge/entity";
import type {
  LiveTopicSummary,
  TopicRepository,
} from "@repo/core/domain/knowledge/ports/topicRepository";
import {
  TopicDescription,
  TopicId,
  TopicName,
} from "@repo/core/domain/knowledge/valueObject";
import { updateMatchedRow } from "../rowRunner";
import { bindChunks, placeholders } from "./bindChunks";
import { occConflict } from "./occ";

type TopicRow = Readonly<{
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived" | "trashed";
  trashed_at: number | null;
  purge_after: number | null;
  was_archived: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}>;

const TOPIC_COLUMNS =
  "id, name, description, status, trashed_at, purge_after, was_archived, version, created_at, updated_at";

const LIVE = "status IN ('active','archived')";

function rehydrate(row: TopicRow, userId: UserId): Topic {
  try {
    const base = {
      id: TopicId.create(row.id),
      userId,
      name: TopicName.create(row.name),
      description:
        row.description === null
          ? null
          : TopicDescription.create(row.description),
      version: row.version,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
    if (row.status === "active") return { ...base, status: "active" };
    if (row.status === "archived") return { ...base, status: "archived" };
    if (
      row.trashed_at === null ||
      row.purge_after === null ||
      row.was_archived === null
    ) {
      throw new RehydrationError(`topic ${row.id}: trashed without its fields`);
    }
    return {
      ...base,
      status: "trashed",
      trashedAt: new Date(row.trashed_at),
      purgeAfter: new Date(row.purge_after),
      wasArchived: row.was_archived === 1,
    };
  } catch (cause) {
    throw new RehydrationError(`topic ${row.id} cannot be rehydrated`, cause);
  }
}

function versioned<T extends Topic>(entity: T, row: TopicRow): Versioned<T> {
  return { entity, expectedVersion: row.version as ExpectedVersion<T> };
}

/** `topics`. A topic has no search entry; names resolve by join at query time. */
export function createTopicRepository(
  sql: SqlStorage,
  selfUserId: string,
): TopicRepository {
  const userId = UserId.create(selfUserId);

  return {
    insert(topic) {
      sql.exec(
        `INSERT INTO topics (${TOPIC_COLUMNS}) VALUES (?, ?, ?, 'active', NULL, NULL, NULL, ?, ?, ?)`,
        topic.id,
        topic.name,
        topic.description,
        topic.version,
        topic.createdAt.getTime(),
        topic.updatedAt.getTime(),
      );
    },

    save(topic, expectedVersion) {
      const trashed = topic.status === "trashed";
      const matched = updateMatchedRow(
        sql,
        `UPDATE topics SET name = ?, description = ?, status = ?, trashed_at = ?, purge_after = ?, was_archived = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
        topic.name,
        topic.description,
        topic.status,
        trashed ? topic.trashedAt.getTime() : null,
        trashed ? topic.purgeAfter.getTime() : null,
        trashed ? (topic.wasArchived ? 1 : 0) : null,
        topic.version,
        topic.updatedAt.getTime(),
        topic.id,
        expectedVersion as number,
      );
      if (!matched) throw occConflict();
    },

    delete(id, expectedVersion) {
      const matched = updateMatchedRow(
        sql,
        "DELETE FROM topics WHERE id = ? AND version = ?",
        id,
        expectedVersion as number,
      );
      if (!matched) throw occConflict();
    },

    findById(id) {
      const row = sql
        .exec<TopicRow>(
          `SELECT ${TOPIC_COLUMNS} FROM topics WHERE id = ? AND ${LIVE}`,
          id,
        )
        .toArray()[0];
      if (!row) return null;
      const topic = rehydrate(row, userId);
      return topic.status === "trashed" ? null : versioned(topic, row);
    },

    findByIdIncludingTrashed(id) {
      const row = sql
        .exec<TopicRow>(`SELECT ${TOPIC_COLUMNS} FROM topics WHERE id = ?`, id)
        .toArray()[0];
      return row ? versioned(rehydrate(row, userId), row) : null;
    },

    listByUser({ includeArchived }) {
      const statuses = includeArchived
        ? "status IN ('active','archived')"
        : "status = 'active'";
      const result: LiveTopic[] = [];
      for (const row of sql
        .exec<TopicRow>(
          `SELECT ${TOPIC_COLUMNS} FROM topics WHERE ${statuses} ORDER BY name ASC, id ASC`,
        )
        .toArray()) {
        const topic = rehydrate(row, userId);
        if (topic.status !== "trashed") result.push(topic);
      }
      return result;
    },

    listTrashedByUser() {
      return sql
        .exec<TopicRow>(
          `SELECT ${TOPIC_COLUMNS} FROM topics WHERE status = 'trashed' ORDER BY trashed_at DESC`,
        )
        .toArray()
        .map((row) => versioned(rehydrate(row, userId) as TrashedTopic, row));
    },

    listSummariesByIds(ids) {
      const result: LiveTopicSummary[] = [];
      for (const chunk of bindChunks(ids)) {
        for (const row of sql
          .exec<Pick<TopicRow, "id" | "name" | "status">>(
            `SELECT id, name, status FROM topics WHERE ${LIVE} AND id IN (${placeholders(chunk.length)})`,
            ...chunk,
          )
          .toArray()) {
          if (row.status === "trashed") continue;
          result.push({
            id: TopicId.create(row.id),
            name: TopicName.create(row.name),
            status: row.status,
          });
        }
      }
      return result;
    },

    recalculatePurgeAfter(retentionDays, limit) {
      const retentionMs = retentionDays * 86_400_000;
      const updated = sql
        .exec<{ matched: number }>(
          `UPDATE topics SET purge_after = trashed_at + ?
           WHERE id IN (
             SELECT id FROM topics WHERE status = 'trashed' AND purge_after <> trashed_at + ? LIMIT ?
           ) RETURNING 1 AS matched`,
          retentionMs,
          retentionMs,
          limit,
        )
        .toArray().length;
      const remaining = sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM topics WHERE status = 'trashed' AND purge_after <> trashed_at + ?",
          retentionMs,
        )
        .one().n;
      return { updatedCount: updated, hasMore: remaining > 0 };
    },
  };
}
