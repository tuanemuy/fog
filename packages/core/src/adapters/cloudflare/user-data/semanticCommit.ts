import {
  ConflictError,
  NotFoundError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import type {
  DocumentWriteDto,
  MemoWriteDto,
  SearchContentKind,
  SearchProjectionEntry,
  SemanticCommand,
  SemanticCommitPort,
  SemanticCommitResult,
  TopicWriteDto,
} from "@repo/core/application/search/contracts";
import { SearchErrorCode } from "@repo/core/application/search/contracts";
import { type DurableSqlStorage, sqliteErrorCode } from "../sql";
import { payloadDigest } from "./canonical";
import { Fts5SearchAdapter } from "./searchIndex";

const MAX_TITLE_BYTES = 1_024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SOURCES = 100;
const DAY_MS = 86_400_000;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function commandTimestamp(command: SemanticCommand): number {
  switch (command.type) {
    case "create-memo":
    case "update-memo":
    case "restore-memo":
      return command.memo.timestamp;
    case "create-document":
    case "update-document":
    case "restore-document":
      return command.document.timestamp;
    case "create-topic":
      return command.topic.timestamp;
    case "trash-memo":
    case "trash-document":
    case "trash-topic":
      return command.trashedAt;
    case "remove-memo":
    case "remove-document":
    case "remove-topic":
      return command.removedAt;
    case "restore-topic":
      return command.restoredAt;
    case "set-topic-archived":
      return command.updatedAt;
  }
}

function commandPayload(command: SemanticCommand): unknown {
  const { operationId: _operationId, ...payload } = command;
  return payload;
}

export class UserDataSemanticCommit implements SemanticCommitPort {
  constructor(
    private readonly storage: DurableSqlStorage,
    private readonly retentionDays: () => number,
  ) {}

  commit(command: SemanticCommand): SemanticCommitResult {
    try {
      return this.storage.transactionSync(() => {
        const digest = payloadDigest(commandPayload(command));
        const duplicate = this.storage.sql
          .exec<{
            command_kind: string;
            payload_digest: string;
            result_json: string;
          }>(
            `SELECT command_kind, payload_digest, result_json
             FROM idempotency
             WHERE namespace = 'semantic' AND operation_id = ?`,
            command.operationId,
          )
          .toArray()[0];
        if (duplicate) {
          if (
            duplicate.command_kind !== command.type ||
            duplicate.payload_digest !== digest
          ) {
            throw new ConflictError(
              SearchErrorCode.IdempotencyConflict,
              "Operation ID was already used with a different semantic command",
            );
          }
          return {
            ...(JSON.parse(duplicate.result_json) as SemanticCommitResult),
            replayed: true,
          };
        }
        this.execute(command);
        const result: SemanticCommitResult = {
          operationId: command.operationId,
          replayed: false,
        };
        this.storage.sql.exec(
          `INSERT INTO idempotency(
             namespace, operation_id, command_kind, payload_digest,
             result_json, completed_at
           ) VALUES ('semantic', ?, ?, ?, ?, ?)`,
          command.operationId,
          command.type,
          digest,
          JSON.stringify(result),
          commandTimestamp(command),
        );
        return result;
      });
    } catch (error) {
      if (
        error instanceof ConflictError ||
        error instanceof NotFoundError ||
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
        "Semantic commit failed",
        error,
      );
    }
  }

  private execute(command: SemanticCommand): void {
    switch (command.type) {
      case "create-memo":
        this.writeMemo(command.memo, "create");
        return;
      case "update-memo":
        this.writeMemo(command.memo, "update");
        return;
      case "trash-memo":
        this.trashContent(command.memoId, "memo", command.trashedAt);
        return;
      case "restore-memo":
        this.restoreMemo(command.memo);
        return;
      case "remove-memo":
        this.hardDelete(command.memoId, "memo");
        return;
      case "create-document":
        this.writeDocument(command.document, "create");
        return;
      case "update-document":
        this.writeDocument(command.document, "update");
        return;
      case "trash-document":
        this.trashContent(command.documentId, "document", command.trashedAt);
        return;
      case "restore-document":
        this.restoreDocument(command.document);
        return;
      case "remove-document":
        this.hardDelete(command.documentId, "document");
        return;
      case "create-topic":
        this.createTopic(command.topic);
        return;
      case "set-topic-archived":
        this.setTopicArchived(
          command.topicId,
          command.archivedAt,
          command.updatedAt,
        );
        return;
      case "trash-topic":
        this.setTopicTrash(command.topicId, command.trashedAt, true);
        return;
      case "restore-topic":
        this.setTopicTrash(command.topicId, command.restoredAt, false);
        return;
      case "remove-topic":
        this.removeTopic(command.topicId);
        return;
    }
  }

  private writeMemo(memo: MemoWriteDto, mode: "create" | "update"): void {
    this.validateText("", memo.body);
    this.assertWriteMode(memo.id, "memo", mode);
    if (mode === "create") {
      this.storage.sql.exec(
        `INSERT INTO content(
           id, kind, title, body, created_at, updated_at
         ) VALUES (?, 'memo', '', ?, ?, ?)`,
        memo.id,
        memo.body,
        memo.timestamp,
        memo.timestamp,
      );
    } else {
      this.storage.sql.exec(
        `UPDATE content SET body = ?, updated_at = ?
         WHERE id = ? AND kind = 'memo' AND trashed_at IS NULL`,
        memo.body,
        memo.timestamp,
        memo.id,
      );
    }
    this.addRevision(memo.id, "", memo.body, memo.timestamp);
    this.projection().apply({
      type: "upsert",
      entry: this.readProjection(memo.id),
    });
  }

  private restoreMemo(memo: MemoWriteDto): void {
    this.assertTrashed(memo.id, "memo");
    this.validateText("", memo.body);
    this.storage.sql.exec(
      `UPDATE content SET body = ?, trashed_at = NULL, updated_at = ?
       WHERE id = ? AND kind = 'memo'`,
      memo.body,
      memo.timestamp,
      memo.id,
    );
    this.storage.sql.exec("DELETE FROM trash WHERE content_id = ?", memo.id);
    this.addRevision(memo.id, "", memo.body, memo.timestamp);
    this.projection().apply({
      type: "upsert",
      entry: this.readProjection(memo.id),
    });
  }

  private writeDocument(
    document: DocumentWriteDto,
    mode: "create" | "update",
  ): void {
    this.validateDocument(document);
    this.assertWriteMode(document.id, "document", mode);
    this.assertTopic(document.topicId);
    this.assertSources(document.sourceMemoIds);
    if (mode === "create") {
      this.storage.sql.exec(
        `INSERT INTO content(
           id, kind, title, body, topic_id, created_at, updated_at
         ) VALUES (?, 'document', ?, ?, ?, ?, ?)`,
        document.id,
        document.title,
        document.body,
        document.topicId,
        document.timestamp,
        document.timestamp,
      );
    } else {
      this.storage.sql.exec(
        `UPDATE content SET title = ?, body = ?, topic_id = ?, updated_at = ?
         WHERE id = ? AND kind = 'document' AND trashed_at IS NULL`,
        document.title,
        document.body,
        document.topicId,
        document.timestamp,
        document.id,
      );
    }
    this.replaceSources(
      document.id,
      document.sourceMemoIds,
      document.timestamp,
    );
    this.addRevision(
      document.id,
      document.title,
      document.body,
      document.timestamp,
    );
    this.projection().apply({
      type: "upsert",
      entry: this.readProjection(document.id),
    });
  }

  private restoreDocument(document: DocumentWriteDto): void {
    this.assertTrashed(document.id, "document");
    this.validateDocument(document);
    this.assertTopic(document.topicId);
    this.assertSources(document.sourceMemoIds);
    this.storage.sql.exec(
      `UPDATE content
       SET title = ?, body = ?, topic_id = ?, trashed_at = NULL, updated_at = ?
       WHERE id = ? AND kind = 'document'`,
      document.title,
      document.body,
      document.topicId,
      document.timestamp,
      document.id,
    );
    this.storage.sql.exec(
      "DELETE FROM trash WHERE content_id = ?",
      document.id,
    );
    this.replaceSources(
      document.id,
      document.sourceMemoIds,
      document.timestamp,
    );
    this.addRevision(
      document.id,
      document.title,
      document.body,
      document.timestamp,
    );
    this.projection().apply({
      type: "upsert",
      entry: this.readProjection(document.id),
    });
  }

  private trashContent(
    id: string,
    expectedKind: SearchContentKind,
    trashedAt: number,
  ): void {
    this.assertActive(id, expectedKind);
    this.storage.sql.exec(
      "UPDATE content SET trashed_at = ?, updated_at = ? WHERE id = ?",
      trashedAt,
      trashedAt,
      id,
    );
    this.storage.sql.exec(
      `INSERT INTO trash(content_id, content_kind, trashed_at, purge_after)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(content_id) DO UPDATE SET
         content_kind = excluded.content_kind,
         trashed_at = excluded.trashed_at,
         purge_after = excluded.purge_after`,
      id,
      expectedKind,
      trashedAt,
      trashedAt + this.retentionDays() * DAY_MS,
    );
    this.projection().apply({
      type: "remove",
      entityType: expectedKind,
      id,
    });
  }

  private hardDelete(id: string, expectedKind: SearchContentKind): void {
    this.assertTrashed(id, expectedKind);
    this.projection().apply({
      type: "remove",
      entityType: expectedKind,
      id,
    });
    this.storage.sql.exec("DELETE FROM content WHERE id = ?", id);
  }

  private createTopic(topic: TopicWriteDto): void {
    if (topic.sourceMemoId !== undefined) {
      this.assertSources([topic.sourceMemoId]);
    }
    const existing = this.storage.sql
      .exec<{ id: string }>("SELECT id FROM topics WHERE id = ?", topic.id)
      .toArray()[0];
    if (existing) {
      throw new ConflictError(
        SearchErrorCode.ContentAlreadyExists,
        "Topic already exists",
      );
    }
    this.storage.sql.exec(
      `INSERT INTO topics(
         id, name, source_memo_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
      topic.id,
      topic.name,
      topic.sourceMemoId ?? null,
      topic.timestamp,
      topic.timestamp,
    );
  }

  private setTopicArchived(
    topicId: string,
    archivedAt: number | null,
    updatedAt: number,
  ): void {
    this.assertTopic(topicId);
    this.storage.sql.exec(
      "UPDATE topics SET archived_at = ?, updated_at = ? WHERE id = ?",
      archivedAt,
      updatedAt,
      topicId,
    );
  }

  private setTopicTrash(
    topicId: string,
    timestamp: number,
    trashed: boolean,
  ): void {
    const state = this.storage.sql
      .exec<{ trashed_at: number | null }>(
        "SELECT trashed_at FROM topics WHERE id = ?",
        topicId,
      )
      .toArray()[0];
    if (
      !state ||
      (trashed ? state.trashed_at !== null : state.trashed_at === null)
    ) {
      throw new NotFoundError(
        SearchErrorCode.TopicNotFound,
        trashed ? "Active topic was not found" : "Trashed topic was not found",
      );
    }
    if (trashed) {
      const documents = this.storage.sql
        .exec<{ id: string }>(
          `SELECT id FROM content
           WHERE kind = 'document' AND topic_id = ?
             AND trashed_at IS NULL AND trashed_with_topic_id IS NULL`,
          topicId,
        )
        .toArray();
      this.storage.sql.exec(
        `UPDATE topics
         SET trashed_at = ?, purge_after = ?, updated_at = ? WHERE id = ?`,
        timestamp,
        timestamp + this.retentionDays() * DAY_MS,
        timestamp,
        topicId,
      );
      this.storage.sql.exec(
        `UPDATE content
         SET trashed_with_topic_id = ?, updated_at = ?
         WHERE kind = 'document' AND topic_id = ?
           AND trashed_at IS NULL AND trashed_with_topic_id IS NULL`,
        topicId,
        timestamp,
        topicId,
      );
      for (const document of documents) {
        this.projection().apply({
          type: "remove",
          entityType: "document",
          id: document.id,
        });
      }
      return;
    }
    const documents = this.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM content
         WHERE kind = 'document' AND trashed_with_topic_id = ?`,
        topicId,
      )
      .toArray();
    this.storage.sql.exec(
      `UPDATE topics
       SET trashed_at = NULL, purge_after = NULL, updated_at = ? WHERE id = ?`,
      timestamp,
      topicId,
    );
    this.storage.sql.exec(
      `UPDATE content
       SET trashed_with_topic_id = NULL, updated_at = ?
       WHERE kind = 'document' AND trashed_with_topic_id = ?`,
      timestamp,
      topicId,
    );
    for (const document of documents) {
      this.projection().apply({
        type: "upsert",
        entry: this.readProjection(document.id),
      });
    }
  }

  private removeTopic(topicId: string): void {
    const topic = this.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM topics WHERE id = ? AND trashed_at IS NOT NULL",
        topicId,
      )
      .toArray()[0];
    if (!topic) {
      throw new NotFoundError(
        SearchErrorCode.TopicNotFound,
        "Trashed topic was not found",
      );
    }
    const setDocuments = this.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM content
         WHERE kind = 'document' AND trashed_with_topic_id = ?`,
        topicId,
      )
      .toArray();
    for (const document of setDocuments) {
      this.projection().apply({
        type: "remove",
        entityType: "document",
        id: document.id,
      });
    }
    this.storage.sql.exec(
      "DELETE FROM content WHERE kind = 'document' AND trashed_with_topic_id = ?",
      topicId,
    );
    this.storage.sql.exec(
      `UPDATE content SET topic_id = NULL
       WHERE kind = 'document' AND topic_id = ?`,
      topicId,
    );
    this.storage.sql.exec("DELETE FROM topics WHERE id = ?", topicId);
  }

  private projection(): Fts5SearchAdapter {
    return new Fts5SearchAdapter(this.storage.sql);
  }

  private readProjection(id: string): SearchProjectionEntry {
    const row = this.storage.sql
      .exec<{
        id: string;
        kind: SearchContentKind;
        title: string;
        body: string;
        topic_id: string | null;
        updated_at: number;
      }>(
        `SELECT id, kind, title, body, topic_id, updated_at
         FROM content WHERE id = ?`,
        id,
      )
      .one();
    if (row.kind === "memo") {
      const documentIds = this.storage.sql
        .exec<{ content_id: string }>(
          `SELECT cs.content_id FROM content_sources cs
           JOIN content d ON d.id = cs.content_id
             AND d.trashed_at IS NULL AND d.trashed_with_topic_id IS NULL
           JOIN topics t ON t.id = d.topic_id AND t.trashed_at IS NULL
           WHERE cs.memo_id = ? ORDER BY cs.content_id`,
          id,
        )
        .toArray()
        .map((link) => link.content_id);
      return {
        type: "memo",
        id,
        body: row.body,
        timestamp: row.updated_at,
        sourceOfDocumentIds: documentIds,
      };
    }
    if (row.topic_id === null) {
      throw new ConflictError(
        SearchErrorCode.TopicRequired,
        "Document must belong to a topic",
      );
    }
    const sourceMemoIds = this.storage.sql
      .exec<{ memo_id: string }>(
        `SELECT cs.memo_id FROM content_sources cs
         JOIN content m ON m.id = cs.memo_id AND m.trashed_at IS NULL
         WHERE cs.content_id = ? ORDER BY cs.memo_id`,
        id,
      )
      .toArray()
      .map((link) => link.memo_id);
    return {
      type: "document",
      id,
      title: row.title,
      body: row.body,
      timestamp: row.updated_at,
      topicId: row.topic_id,
      sourceMemoIds,
    };
  }

  private replaceSources(
    documentId: string,
    sourceMemoIds: readonly string[],
    linkedAt: number,
  ): void {
    this.storage.sql.exec(
      "DELETE FROM content_sources WHERE content_id = ?",
      documentId,
    );
    for (const memoId of [...new Set(sourceMemoIds)].sort()) {
      this.storage.sql.exec(
        `INSERT INTO content_sources(content_id, memo_id, label, linked_at)
         VALUES (?, ?, '', ?)`,
        documentId,
        memoId,
        linkedAt,
      );
    }
  }

  private addRevision(
    contentId: string,
    title: string,
    body: string,
    timestamp: number,
  ): void {
    const version = this.storage.sql
      .exec<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM content_revisions WHERE content_id = ?`,
        contentId,
      )
      .one().version;
    this.storage.sql.exec(
      `INSERT INTO content_revisions(
         content_id, version, title, body, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
      contentId,
      version,
      title,
      body,
      timestamp,
    );
  }

  private assertWriteMode(
    id: string,
    kind: SearchContentKind,
    mode: "create" | "update",
  ): void {
    const row = this.storage.sql
      .exec<{
        kind: SearchContentKind;
        trashed_at: number | null;
        trashed_with_topic_id: string | null;
      }>(
        `SELECT kind, trashed_at, trashed_with_topic_id
         FROM content WHERE id = ?`,
        id,
      )
      .toArray()[0];
    if (mode === "create" && row) {
      throw new ConflictError(
        SearchErrorCode.ContentAlreadyExists,
        "Content already exists",
      );
    }
    if (mode === "update" && !row) {
      throw new NotFoundError(
        SearchErrorCode.ContentNotFound,
        "Content was not found",
      );
    }
    if (row && row.kind !== kind) {
      throw new ConflictError(
        SearchErrorCode.ContentKindConflict,
        "Content kind cannot be changed",
      );
    }
    if (
      mode === "update" &&
      row &&
      (row.trashed_at !== null || row.trashed_with_topic_id !== null)
    ) {
      throw new ConflictError(
        SearchErrorCode.ContentNotFound,
        "Trashed content must be restored before updating",
      );
    }
  }

  private assertExists(id: string, kind: SearchContentKind): void {
    const row = this.storage.sql
      .exec<{ kind: SearchContentKind }>(
        "SELECT kind FROM content WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (!row) {
      throw new NotFoundError(
        SearchErrorCode.ContentNotFound,
        "Content was not found",
      );
    }
    if (row.kind !== kind) {
      throw new ConflictError(
        SearchErrorCode.ContentKindConflict,
        "Content kind did not match",
      );
    }
  }

  private assertActive(id: string, kind: SearchContentKind): void {
    this.assertExists(id, kind);
    const row = this.storage.sql
      .exec<{
        trashed_at: number | null;
        trashed_with_topic_id: string | null;
      }>(
        `SELECT trashed_at, trashed_with_topic_id
         FROM content WHERE id = ?`,
        id,
      )
      .one();
    if (row.trashed_at !== null || row.trashed_with_topic_id !== null) {
      throw new ConflictError(
        SearchErrorCode.ContentNotFound,
        "Content is already trashed",
      );
    }
  }

  private assertTrashed(id: string, kind: SearchContentKind): void {
    this.assertExists(id, kind);
    const row = this.storage.sql
      .exec<{ trashed_at: number | null }>(
        "SELECT trashed_at FROM content WHERE id = ?",
        id,
      )
      .one();
    if (row.trashed_at === null) {
      throw new ConflictError(
        SearchErrorCode.ContentNotFound,
        "Content is not in trash",
      );
    }
  }

  private assertTopic(topicId: string, includeTrash = false): void {
    const row = this.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM topics
         WHERE id = ? AND (? = 1 OR trashed_at IS NULL)`,
        topicId,
        includeTrash ? 1 : 0,
      )
      .toArray()[0];
    if (!row) {
      throw new NotFoundError(
        SearchErrorCode.TopicNotFound,
        "Topic was not found",
      );
    }
  }

  private assertSources(sourceMemoIds: readonly string[]): void {
    if (sourceMemoIds.length > MAX_SOURCES) {
      throw new ConflictError(
        SearchErrorCode.SourceLimitExceeded,
        `A document may have at most ${MAX_SOURCES} source memos`,
      );
    }
    for (const memoId of new Set(sourceMemoIds)) {
      const row = this.storage.sql
        .exec<{ id: string }>(
          `SELECT id FROM content
           WHERE id = ? AND kind = 'memo' AND trashed_at IS NULL`,
          memoId,
        )
        .toArray()[0];
      if (!row) {
        throw new NotFoundError(
          SearchErrorCode.SourceNotFound,
          "Source memo was not found",
        );
      }
    }
  }

  private validateDocument(document: DocumentWriteDto): void {
    this.validateText(document.title, document.body);
    if (document.topicId.length === 0) {
      throw new ConflictError(
        SearchErrorCode.TopicRequired,
        "Document must belong to a topic",
      );
    }
  }

  private validateText(title: string, body: string): void {
    if (
      byteLength(title) > MAX_TITLE_BYTES ||
      byteLength(body) > MAX_BODY_BYTES
    ) {
      throw new ConflictError(
        SearchErrorCode.ContentLimitExceeded,
        "Content exceeds the User Data command limits",
      );
    }
  }
}
