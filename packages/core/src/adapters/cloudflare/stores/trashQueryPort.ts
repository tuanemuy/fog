import type {
  DocumentId,
  TopicId,
} from "@repo/core/domain/knowledge/valueObject";
import type { MemoId } from "@repo/core/domain/memo/valueObject";
import type { TrashQueryPort } from "@repo/core/domain/trash/ports/trashQueryPort";
import type {
  TrashedDocumentItem,
  TrashedMemoItem,
  TrashedTopicItem,
  TrashItem,
} from "@repo/core/domain/trash/valueObject";
import { snippetOf } from "@repo/core/lib/text";

type UnionRow = Readonly<{
  kind: "memo" | "document" | "topic";
  id: string;
  text: string;
  topic_id: string | null;
  trashed_with: string | null;
  trashed_at: number;
  purge_after: number;
}>;

/**
 * One UNION over the three trashed sets, each branch answered from its own
 * `*_trash_idx` / `*_purge_idx`. `text` is the memo body, the document
 * title or the topic name; the memo body is cut to an excerpt here.
 */
const UNION = `
  SELECT 'memo' AS kind, id, body AS text, NULL AS topic_id, NULL AS trashed_with, trashed_at, purge_after
    FROM memos WHERE status = 'trashed'
  UNION ALL
  SELECT 'document', id, title, topic_id, trashed_with, trashed_at, purge_after
    FROM documents WHERE status = 'trashed'
  UNION ALL
  SELECT 'topic', id, name, NULL, NULL, trashed_at, purge_after
    FROM topics WHERE status = 'trashed'`;

export function createTrashQueryPort(sql: SqlStorage): TrashQueryPort {
  function setDocumentIds(topicId: string): DocumentId[] {
    return sql
      .exec<{ id: string }>(
        "SELECT id FROM documents WHERE status = 'trashed' AND trashed_with = ? ORDER BY trashed_at DESC, id",
        topicId,
      )
      .toArray()
      .map((row) => row.id as DocumentId);
  }

  function toItem(row: UnionRow): TrashItem {
    const trashedAt = new Date(row.trashed_at);
    const expiresAt = new Date(row.purge_after);
    switch (row.kind) {
      case "memo": {
        const item: TrashedMemoItem = {
          kind: "memo",
          id: row.id as MemoId,
          excerpt: snippetOf(row.text),
          trashedAt,
          expiresAt,
        };
        return item;
      }
      case "document": {
        const item: TrashedDocumentItem = {
          kind: "document",
          id: row.id as DocumentId,
          title: row.text,
          topicId: row.topic_id as TopicId,
          deletedWithTopic: row.trashed_with !== null,
          trashedAt,
          expiresAt,
        };
        return item;
      }
      case "topic": {
        const item: TrashedTopicItem = {
          kind: "topic",
          id: row.id as TopicId,
          name: row.text,
          setDocumentIds: setDocumentIds(row.id),
          trashedAt,
          expiresAt,
        };
        return item;
      }
    }
  }

  return {
    listTrashItems({ page, limit }) {
      const items = sql
        .exec<UnionRow>(
          `SELECT * FROM (${UNION}) ORDER BY trashed_at DESC, kind, id LIMIT ? OFFSET ?`,
          limit,
          (page - 1) * limit,
        )
        .toArray()
        .map(toItem);
      return { items, count: this.countTrashItems() };
    },

    findTrashItem(ref) {
      const branch =
        ref.kind === "memo"
          ? "SELECT 'memo' AS kind, id, body AS text, NULL AS topic_id, NULL AS trashed_with, trashed_at, purge_after FROM memos WHERE status = 'trashed' AND id = ?"
          : ref.kind === "document"
            ? "SELECT 'document' AS kind, id, title AS text, topic_id, trashed_with, trashed_at, purge_after FROM documents WHERE status = 'trashed' AND id = ?"
            : "SELECT 'topic' AS kind, id, name AS text, NULL AS topic_id, NULL AS trashed_with, trashed_at, purge_after FROM topics WHERE status = 'trashed' AND id = ?";
      const row = sql.exec<UnionRow>(branch, ref.id).toArray()[0];
      return row === undefined ? null : toItem(row);
    },

    countTrashItems() {
      return sql
        .exec<{ n: number }>(
          `SELECT (SELECT count(*) FROM memos WHERE status = 'trashed')
                + (SELECT count(*) FROM documents WHERE status = 'trashed')
                + (SELECT count(*) FROM topics WHERE status = 'trashed') AS n`,
        )
        .one().n;
    },

    listItemsToPurge(now, limit) {
      const at = now.getTime();
      return sql
        .exec<UnionRow>(
          `SELECT * FROM (
             SELECT 'memo' AS kind, id, body AS text, NULL AS topic_id, NULL AS trashed_with, trashed_at, purge_after
               FROM memos WHERE status = 'trashed' AND purge_after < ?
             UNION ALL
             SELECT 'document', id, title, topic_id, trashed_with, trashed_at, purge_after
               FROM documents WHERE status = 'trashed' AND purge_after < ?
             UNION ALL
             SELECT 'topic', id, name, NULL, NULL, trashed_at, purge_after
               FROM topics WHERE status = 'trashed' AND purge_after < ?
           ) ORDER BY purge_after ASC, kind, id LIMIT ?`,
          at,
          at,
          at,
          limit,
        )
        .toArray()
        .map(toItem);
    },

    findEarliestPurgeAfter() {
      const row = sql
        .exec<{ v: number | null }>(
          `SELECT min(purge_after) AS v FROM (
             SELECT purge_after FROM memos WHERE status = 'trashed'
             UNION ALL SELECT purge_after FROM documents WHERE status = 'trashed'
             UNION ALL SELECT purge_after FROM topics WHERE status = 'trashed'
           )`,
        )
        .one();
      return row.v === null ? null : new Date(row.v);
    },
  };
}
