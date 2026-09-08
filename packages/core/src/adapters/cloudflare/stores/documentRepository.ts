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
  ActiveDocument,
  Document,
  DocumentRevision,
  SourceLink,
  TrashedDocument,
} from "@repo/core/domain/knowledge/entity";
import type {
  ActiveDocumentSummary,
  DocumentRepository,
  DocumentRevisionSummary,
  DocumentSummary,
} from "@repo/core/domain/knowledge/ports/documentRepository";
import {
  ChangeReason,
  DocumentBody,
  DocumentId,
  DocumentRevisionId,
  DocumentTitle,
  RevisionNumber,
  TopicId,
} from "@repo/core/domain/knowledge/valueObject";
import { MemoId } from "@repo/core/domain/memo/valueObject";
import { updateMatchedRow } from "../rowRunner";
import { bindChunks, placeholders } from "./bindChunks";
import { isUniqueViolation, occConflict } from "./occ";
import {
  projectDocument,
  removeSearchEntry,
  reprojectMemo,
} from "./searchProjection";

type DocumentRow = Readonly<{
  id: string;
  topic_id: string;
  title: string;
  body: string;
  latest_revision_number: number;
  status: "active" | "trashed";
  trashed_at: number | null;
  purge_after: number | null;
  trashed_with: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}>;

type SummaryRow = Pick<
  DocumentRow,
  "id" | "topic_id" | "title" | "updated_at" | "status"
>;

type RevisionRow = Readonly<{
  id: string;
  document_id: string;
  revision_number: number;
  title: string;
  body: string;
  actor_type: "user" | "ai_client";
  actor_connection_id: string | null;
  actor_client_name: string | null;
  change_reason: string;
  created_at: number;
}>;

type LinkRow = Readonly<{
  document_id: string;
  memo_id: string;
  created_at: number;
}>;

const DOCUMENT_COLUMNS =
  "id, topic_id, title, body, latest_revision_number, status, trashed_at, purge_after, trashed_with, version, created_at, updated_at";
const SUMMARY_COLUMNS = "id, topic_id, title, updated_at, status";
const REVISION_META_COLUMNS =
  "id, document_id, revision_number, title, actor_type, actor_connection_id, actor_client_name, change_reason, created_at";

function rehydrate(row: DocumentRow, userId: UserId): Document {
  try {
    const base = {
      id: DocumentId.create(row.id),
      userId,
      topicId: TopicId.create(row.topic_id),
      title: DocumentTitle.create(row.title),
      body: DocumentBody.create(row.body),
      latestRevision: RevisionNumber.create(row.latest_revision_number),
      version: row.version,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
    if (row.status === "active") return { ...base, status: "active" };
    if (row.trashed_at === null || row.purge_after === null) {
      throw new RehydrationError(
        `document ${row.id}: trashed without timestamps`,
      );
    }
    return {
      ...base,
      status: "trashed",
      trashedAt: new Date(row.trashed_at),
      purgeAfter: new Date(row.purge_after),
      trashedWith:
        row.trashed_with === null ? null : TopicId.create(row.trashed_with),
    };
  } catch (cause) {
    throw new RehydrationError(
      `document ${row.id} cannot be rehydrated`,
      cause,
    );
  }
}

function summary(row: SummaryRow): DocumentSummary {
  try {
    return {
      id: DocumentId.create(row.id),
      topicId: TopicId.create(row.topic_id),
      title: DocumentTitle.create(row.title),
      updatedAt: new Date(row.updated_at),
      status: row.status,
    };
  } catch (cause) {
    throw new RehydrationError(
      `document ${row.id} cannot be rehydrated`,
      cause,
    );
  }
}

function actorOf(row: RevisionRow, userId: UserId): Actor {
  return row.actor_type === "user"
    ? Actor.user(userId)
    : Actor.aiClient(
        userId,
        AiClientConnectionId.create(row.actor_connection_id ?? ""),
        ClientName.create(row.actor_client_name ?? ""),
      );
}

function rehydrateRevision(row: RevisionRow, userId: UserId): DocumentRevision {
  try {
    return {
      id: DocumentRevisionId.create(row.id),
      documentId: DocumentId.create(row.document_id),
      revisionNumber: RevisionNumber.create(row.revision_number),
      title: DocumentTitle.create(row.title),
      body: DocumentBody.create(row.body),
      actor: actorOf(row, userId),
      changeReason: ChangeReason.create(row.change_reason),
      createdAt: new Date(row.created_at),
    };
  } catch (cause) {
    throw new RehydrationError(
      `document revision ${row.document_id}#${row.revision_number} cannot be rehydrated`,
      cause,
    );
  }
}

function link(row: LinkRow): SourceLink {
  return {
    documentId: DocumentId.create(row.document_id),
    memoId: MemoId.create(row.memo_id),
    createdAt: new Date(row.created_at),
  };
}

function versioned<T extends Document>(
  entity: T,
  row: DocumentRow,
): Versioned<T> {
  return { entity, expectedVersion: row.version as ExpectedVersion<T> };
}

/**
 * `documents` + `document_revisions` + `source_links`, with the search
 * projection — the document's own entry and the entries of the memos it
 * cites — written in the same statement sequence as the rows.
 */
export function createDocumentRepository(
  sql: SqlStorage,
  selfUserId: string,
): DocumentRepository {
  const userId = UserId.create(selfUserId);

  const sourceMemoIds = (documentId: string): string[] =>
    sql
      .exec<{ memo_id: string }>(
        "SELECT memo_id FROM source_links WHERE document_id = ?",
        documentId,
      )
      .toArray()
      .map((row) => row.memo_id);

  const project = (document: Document): void => {
    if (document.status === "active") {
      projectDocument(sql, document);
    } else {
      removeSearchEntry(sql, document.id);
    }
    for (const memoId of sourceMemoIds(document.id)) reprojectMemo(sql, memoId);
  };

  const listSummaries = (
    where: string,
    order: string,
    bindings: SqlStorageValue[],
  ): DocumentSummary[] =>
    sql
      .exec<SummaryRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM documents WHERE ${where} ORDER BY ${order}`,
        ...bindings,
      )
      .toArray()
      .map(summary);

  return {
    insert(document) {
      sql.exec(
        `INSERT INTO documents (${DOCUMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?, ?)`,
        document.id,
        document.topicId,
        document.title,
        document.body,
        document.latestRevision,
        document.version,
        document.createdAt.getTime(),
        document.updatedAt.getTime(),
      );
      projectDocument(sql, document);
    },

    save(document, expectedVersion) {
      const trashed = document.status === "trashed";
      const matched = updateMatchedRow(
        sql,
        `UPDATE documents SET topic_id = ?, title = ?, body = ?, latest_revision_number = ?, status = ?, trashed_at = ?, purge_after = ?, trashed_with = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
        document.topicId,
        document.title,
        document.body,
        document.latestRevision,
        document.status,
        trashed ? document.trashedAt.getTime() : null,
        trashed ? document.purgeAfter.getTime() : null,
        trashed ? document.trashedWith : null,
        document.version,
        document.updatedAt.getTime(),
        document.id,
        expectedVersion as number,
      );
      if (!matched) throw occConflict();
      project(document);
    },

    delete(id, expectedVersion) {
      // The memos to re-project must be known before their links go.
      const memoIds = sourceMemoIds(id);
      const matched = updateMatchedRow(
        sql,
        "DELETE FROM documents WHERE id = ? AND version = ?",
        id,
        expectedVersion as number,
      );
      if (!matched) throw occConflict();
      sql.exec("DELETE FROM document_revisions WHERE document_id = ?", id);
      sql.exec("DELETE FROM source_links WHERE document_id = ?", id);
      removeSearchEntry(sql, id);
      for (const memoId of memoIds) reprojectMemo(sql, memoId);
    },

    findById(id) {
      const row = sql
        .exec<DocumentRow>(
          `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ? AND status = 'active'`,
          id,
        )
        .toArray()[0];
      if (!row) return null;
      const document = rehydrate(row, userId);
      return document.status === "active" ? versioned(document, row) : null;
    },

    findByIdIncludingTrashed(id) {
      const row = sql
        .exec<DocumentRow>(
          `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ?`,
          id,
        )
        .toArray()[0];
      return row ? versioned(rehydrate(row, userId), row) : null;
    },

    listSummariesByIdsIncludingTrashed(ids) {
      const result: DocumentSummary[] = [];
      for (const chunk of bindChunks(ids)) {
        result.push(
          ...listSummaries(`id IN (${placeholders(chunk.length)})`, "id ASC", [
            ...chunk,
          ]),
        );
      }
      return result;
    },

    listActiveByTopic(topicId) {
      const result: Versioned<ActiveDocument>[] = [];
      for (const row of sql
        .exec<DocumentRow>(
          `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE topic_id = ? AND status = 'active' ORDER BY updated_at DESC, id ASC`,
          topicId,
        )
        .toArray()) {
        const document = rehydrate(row, userId);
        if (document.status === "active") result.push(versioned(document, row));
      }
      return result;
    },

    listActiveSummariesByTopic(topicId) {
      return listSummaries(
        "topic_id = ? AND status = 'active'",
        "updated_at DESC, id ASC",
        [topicId],
      ) as ActiveDocumentSummary[];
    },

    listActiveSummariesByTopics(topicIds) {
      const result: ActiveDocumentSummary[] = [];
      for (const chunk of bindChunks(topicIds)) {
        result.push(
          ...(listSummaries(
            `topic_id IN (${placeholders(chunk.length)}) AND status = 'active'`,
            "updated_at DESC, id ASC",
            [...chunk],
          ) as ActiveDocumentSummary[]),
        );
      }
      return result;
    },

    listTrashedByTopic(topicId) {
      return sql
        .exec<DocumentRow>(
          `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE topic_id = ? AND status = 'trashed' ORDER BY trashed_at DESC, id ASC`,
          topicId,
        )
        .toArray()
        .map((row) =>
          versioned(rehydrate(row, userId) as TrashedDocument, row),
        );
    },

    listTrashedByUser() {
      return sql
        .exec<DocumentRow>(
          `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE status = 'trashed' ORDER BY trashed_at DESC`,
        )
        .toArray()
        .map((row) =>
          versioned(rehydrate(row, userId) as TrashedDocument, row),
        );
    },

    insertRevision(revision) {
      const actor = revision.actor;
      try {
        sql.exec(
          `INSERT INTO document_revisions (id, document_id, revision_number, title, body, actor_type, actor_connection_id, actor_client_name, change_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          revision.id,
          revision.documentId,
          revision.revisionNumber,
          revision.title,
          revision.body,
          actor.kind === "user" ? "user" : "ai_client",
          actor.kind === "aiClient" ? actor.connectionId : null,
          actor.kind === "aiClient" ? actor.clientName : null,
          revision.changeReason,
          revision.createdAt.getTime(),
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw occConflict();
        throw error;
      }
    },

    listRevisionSummaries(documentId): DocumentRevisionSummary[] {
      return sql
        .exec<Omit<RevisionRow, "body">>(
          `SELECT ${REVISION_META_COLUMNS} FROM document_revisions WHERE document_id = ? ORDER BY revision_number ASC`,
          documentId,
        )
        .toArray()
        .map((row) => {
          try {
            return {
              revisionNumber: RevisionNumber.create(row.revision_number),
              actor: actorOf({ ...row, body: "" }, userId),
              changeReason: ChangeReason.create(row.change_reason),
              createdAt: new Date(row.created_at),
            };
          } catch (cause) {
            throw new RehydrationError(
              `document revision ${row.document_id}#${row.revision_number} cannot be rehydrated`,
              cause,
            );
          }
        });
    },

    findRevision(documentId, revisionNumber) {
      const row = sql
        .exec<RevisionRow>(
          `SELECT ${REVISION_META_COLUMNS}, body FROM document_revisions WHERE document_id = ? AND revision_number = ?`,
          documentId,
          revisionNumber,
        )
        .toArray()[0];
      return row ? rehydrateRevision(row, userId) : null;
    },

    insertSourceLinks(links) {
      if (links.length === 0) return;
      // Three columns per row: 33 rows stay under the 100-parameter cap.
      for (let index = 0; index < links.length; index += 33) {
        const chunk = links.slice(index, index + 33);
        sql.exec(
          `INSERT INTO source_links (document_id, memo_id, created_at) VALUES ${chunk
            .map(() => "(?, ?, ?)")
            .join(", ")}`,
          ...chunk.flatMap((l) => [
            l.documentId,
            l.memoId,
            l.createdAt.getTime(),
          ]),
        );
      }
      for (const documentId of new Set(links.map((l) => l.documentId))) {
        const row = sql
          .exec<DocumentRow>(
            `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ? AND status = 'active'`,
            documentId,
          )
          .toArray()[0];
        if (row) {
          const document = rehydrate(row, userId);
          if (document.status === "active") projectDocument(sql, document);
        }
      }
      for (const memoId of new Set(links.map((l) => l.memoId))) {
        reprojectMemo(sql, memoId);
      }
    },

    listSourceLinksByDocument(documentId) {
      return sql
        .exec<LinkRow>(
          "SELECT document_id, memo_id, created_at FROM source_links WHERE document_id = ? ORDER BY created_at ASC, memo_id ASC",
          documentId,
        )
        .toArray()
        .map(link);
    },

    listSourceLinksByDocuments(documentIds) {
      const result: SourceLink[] = [];
      for (const chunk of bindChunks(documentIds)) {
        result.push(
          ...sql
            .exec<LinkRow>(
              `SELECT document_id, memo_id, created_at FROM source_links WHERE document_id IN (${placeholders(chunk.length)}) ORDER BY document_id ASC, created_at ASC, memo_id ASC`,
              ...chunk,
            )
            .toArray()
            .map(link),
        );
      }
      return result;
    },

    listSourceLinksByMemo(memoId) {
      return sql
        .exec<LinkRow>(
          "SELECT document_id, memo_id, created_at FROM source_links WHERE memo_id = ? ORDER BY created_at ASC, document_id ASC",
          memoId,
        )
        .toArray()
        .map(link);
    },

    listSourceLinksByMemos(memoIds) {
      const result: SourceLink[] = [];
      for (const chunk of bindChunks(memoIds)) {
        result.push(
          ...sql
            .exec<LinkRow>(
              `SELECT document_id, memo_id, created_at FROM source_links WHERE memo_id IN (${placeholders(chunk.length)}) ORDER BY memo_id ASC, created_at ASC, document_id ASC`,
              ...chunk,
            )
            .toArray()
            .map(link),
        );
      }
      return result;
    },

    deleteSourceLinksByMemo(memoId) {
      const documentIds = sql
        .exec<{ document_id: string }>(
          "SELECT document_id FROM source_links WHERE memo_id = ?",
          memoId,
        )
        .toArray()
        .map((row) => row.document_id);
      sql.exec("DELETE FROM source_links WHERE memo_id = ?", memoId);
      for (const documentId of documentIds) {
        const row = sql
          .exec<DocumentRow>(
            `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ? AND status = 'active'`,
            documentId,
          )
          .toArray()[0];
        if (row) {
          const document = rehydrate(row, userId);
          if (document.status === "active") projectDocument(sql, document);
        }
      }
    },

    recalculatePurgeAfter(retentionDays, limit) {
      const retentionMs = retentionDays * 86_400_000;
      const updated = sql
        .exec<{ matched: number }>(
          `UPDATE documents SET purge_after = trashed_at + ?
           WHERE id IN (
             SELECT id FROM documents WHERE status = 'trashed' AND purge_after <> trashed_at + ? LIMIT ?
           ) RETURNING 1 AS matched`,
          retentionMs,
          retentionMs,
          limit,
        )
        .toArray().length;
      const remaining = sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM documents WHERE status = 'trashed' AND purge_after <> trashed_at + ?",
          retentionMs,
        )
        .one().n;
      return { updatedCount: updated, hasMore: remaining > 0 };
    },
  };
}
