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
import { BusinessRuleError } from "@repo/core/domain/error";
import { type DurableSqlStorage, sqliteErrorCode } from "../sql";
import { payloadDigest } from "./canonical";
import { DurableJobStore } from "./jobs";
import { Fts5SearchAdapter } from "./searchIndex";

const MAX_TITLE_BYTES = 1_024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MEMO_BODY_CODE_POINTS = 10_000;
const MAX_DOCUMENT_TITLE_CODE_POINTS = 200;
const MAX_SOURCES = 100;
const SOURCE_INSERT_BATCH = 33;
const DAY_MS = 86_400_000;
const MAX_TOPIC_DOCUMENTS_PER_COMMAND = 100;
const IDEMPOTENCY_RETENTION_MS = 90 * DAY_MS;
const MAX_SEMANTIC_IDEMPOTENCY_ROWS = 10_000;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function commandTimestamp(command: SemanticCommand): number {
  switch (command.type) {
    case "create-memo":
    case "update-memo":
      return command.memo.timestamp;
    case "restore-memo":
    case "restore-document":
      return command.restoredAt;
    case "create-document":
    case "update-document":
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
  if (
    payload.type === "create-document" ||
    payload.type === "update-document"
  ) {
    return {
      ...payload,
      document: {
        ...payload.document,
        sourceMemoIds: [...new Set(payload.document.sourceMemoIds)].sort(),
      },
    };
  }
  return payload;
}

export class UserDataSemanticCommit implements SemanticCommitPort {
  constructor(
    private readonly storage: DurableSqlStorage,
    private readonly retentionDays: () => number,
  ) {}

  transactionSync(
    command: SemanticCommand,
    callback?: Parameters<SemanticCommitPort["transactionSync"]>[1],
  ): SemanticCommitResult {
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
        callback?.({ storage: "user-data" }, this.projection());
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
        this.pruneIdempotency(commandTimestamp(command));
        return result;
      });
    } catch (error) {
      if (
        error instanceof ConflictError ||
        error instanceof NotFoundError ||
        error instanceof SystemError ||
        error instanceof BusinessRuleError
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

  private pruneIdempotency(now: number): void {
    this.storage.sql.exec(
      `DELETE FROM idempotency
       WHERE namespace = 'semantic' AND completed_at < ?`,
      now - IDEMPOTENCY_RETENTION_MS,
    );
    this.storage.sql.exec(
      `DELETE FROM idempotency
       WHERE namespace = 'semantic' AND operation_id IN (
         SELECT operation_id FROM idempotency
         WHERE namespace = 'semantic'
         ORDER BY completed_at DESC, operation_id DESC
         LIMIT -1 OFFSET ?
       )`,
      MAX_SEMANTIC_IDEMPOTENCY_ROWS,
    );
  }

  private execute(command: SemanticCommand): void {
    switch (command.type) {
      case "create-memo":
        this.writeMemo(
          command.memo,
          "create",
          undefined,
          command.actorId,
          undefined,
        );
        return;
      case "update-memo":
        this.writeMemo(
          command.memo,
          "update",
          command.expectedVersion,
          command.actorId,
          command.changeReason,
        );
        return;
      case "trash-memo":
        this.assertExpectedVersion(command.memoId, command.expectedVersion);
        this.trashContent(command.memoId, "memo", command.trashedAt);
        this.enqueueRetention("memo", command.memoId, command.trashedAt);
        return;
      case "restore-memo":
        this.assertExpectedVersion(command.memoId, command.expectedVersion);
        this.restoreContent(
          command.memoId,
          "memo",
          command.restoredAt,
          command.actorId,
        );
        return;
      case "remove-memo":
        this.assertExpectedVersion(command.memoId, command.expectedVersion);
        this.hardDelete(command.memoId, "memo");
        return;
      case "create-document":
        this.writeDocument(
          command.document,
          "create",
          undefined,
          command.actorId,
          "created",
        );
        return;
      case "update-document":
        this.writeDocument(
          command.document,
          "update",
          command.expectedVersion,
          command.actorId,
          command.changeReason,
        );
        return;
      case "trash-document":
        this.assertExpectedVersion(command.documentId, command.expectedVersion);
        this.trashContent(command.documentId, "document", command.trashedAt);
        this.enqueueRetention(
          "document",
          command.documentId,
          command.trashedAt,
        );
        return;
      case "restore-document":
        this.assertExpectedVersion(command.documentId, command.expectedVersion);
        this.restoreContent(
          command.documentId,
          "document",
          command.restoredAt,
          command.actorId,
        );
        return;
      case "remove-document":
        this.assertExpectedVersion(command.documentId, command.expectedVersion);
        this.hardDelete(command.documentId, "document");
        return;
      case "create-topic":
        this.createTopic(command.topic);
        return;
      case "set-topic-archived":
        this.assertTopicExpectedVersion(
          command.topicId,
          command.expectedVersion,
        );
        this.setTopicArchived(
          command.topicId,
          command.archivedAt,
          command.updatedAt,
        );
        return;
      case "trash-topic":
        this.assertTopicExpectedVersion(
          command.topicId,
          command.expectedVersion,
        );
        this.setTopicTrash(command.topicId, command.trashedAt, true);
        this.enqueueRetention("topic", command.topicId, command.trashedAt);
        return;
      case "restore-topic":
        this.assertTopicExpectedVersion(
          command.topicId,
          command.expectedVersion,
        );
        this.setTopicTrash(command.topicId, command.restoredAt, false);
        return;
      case "remove-topic":
        this.assertTopicExpectedVersion(
          command.topicId,
          command.expectedVersion,
        );
        this.removeTopic(command.topicId);
        return;
    }
  }

  private writeMemo(
    memo: MemoWriteDto,
    mode: "create" | "update",
    expectedVersion: number | undefined,
    actorId: string | undefined,
    changeReason: string | undefined,
  ): void {
    this.validateMemo(memo.body);
    this.assertWriteMode(memo.id, "memo", mode);
    if (mode === "update") {
      this.assertExpectedVersion(memo.id, expectedVersion);
      const current = this.storage.sql
        .exec<{ body: string }>(
          "SELECT body FROM content WHERE id = ? AND kind = 'memo'",
          memo.id,
        )
        .one();
      if (current.body === memo.body) return;
    }
    if (mode === "create") {
      this.storage.sql.exec(
        `INSERT INTO content(
           id, kind, title, body, version, updated_by, created_at, updated_at
         ) VALUES (?, 'memo', '', ?, 1, ?, ?, ?)`,
        memo.id,
        memo.body,
        actorId ?? "local-user",
        memo.timestamp,
        memo.timestamp,
      );
    } else {
      this.storage.sql.exec(
        `UPDATE content
         SET body = ?, version = version + 1, updated_by = ?, updated_at = ?
         WHERE id = ? AND kind = 'memo' AND trashed_at IS NULL`,
        memo.body,
        actorId ?? "local-user",
        memo.timestamp,
        memo.id,
      );
    }
    this.addRevision(
      memo.id,
      "",
      memo.body,
      memo.timestamp,
      actorId,
      changeReason,
    );
    this.projection().upsert(this.readProjection(memo.id));
  }

  private writeDocument(
    document: DocumentWriteDto,
    mode: "create" | "update",
    expectedVersion: number | undefined,
    actorId: string | undefined,
    changeReason: string | undefined,
  ): void {
    this.validateDocument(document);
    this.assertWriteMode(document.id, "document", mode);
    if (mode === "update") {
      this.assertExpectedVersion(document.id, expectedVersion);
    }
    this.assertTopic(document.topicId);
    const sourceMemoIds = this.normalizeSources(document.sourceMemoIds);
    this.assertSources(sourceMemoIds);
    if (
      mode === "update" &&
      this.documentIsUnchanged(document, sourceMemoIds)
    ) {
      return;
    }
    if (mode === "create") {
      this.storage.sql.exec(
        `INSERT INTO content(
           id, kind, title, body, topic_id, version, updated_by,
           created_at, updated_at
         ) VALUES (?, 'document', ?, ?, ?, 1, ?, ?, ?)`,
        document.id,
        document.title,
        document.body,
        document.topicId,
        actorId ?? "local-user",
        document.timestamp,
        document.timestamp,
      );
    } else {
      this.storage.sql.exec(
        `UPDATE content
         SET title = ?, body = ?, topic_id = ?, version = version + 1,
             updated_by = ?, updated_at = ?
         WHERE id = ? AND kind = 'document' AND trashed_at IS NULL`,
        document.title,
        document.body,
        document.topicId,
        actorId ?? "local-user",
        document.timestamp,
        document.id,
      );
    }
    this.replaceSources(document.id, sourceMemoIds, document.timestamp);
    this.addRevision(
      document.id,
      document.title,
      document.body,
      document.timestamp,
      actorId,
      changeReason,
    );
    this.projection().upsert(this.readProjection(document.id));
  }

  private trashContent(
    id: string,
    expectedKind: SearchContentKind,
    trashedAt: number,
  ): void {
    this.assertActive(id, expectedKind);
    this.storage.sql.exec(
      `UPDATE content
       SET trashed_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
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
    this.projection().remove(expectedKind, id);
  }

  private restoreContent(
    id: string,
    kind: SearchContentKind,
    restoredAt: number,
    actorId?: string,
  ): void {
    this.assertTrashed(id, kind);
    this.storage.sql.exec(
      `UPDATE content
       SET trashed_at = NULL, version = version + 1, updated_by = ?,
           updated_at = ?
       WHERE id = ? AND kind = ?`,
      actorId ?? "local-user",
      restoredAt,
      id,
      kind,
    );
    this.storage.sql.exec("DELETE FROM trash WHERE content_id = ?", id);
    this.projection().upsert(this.readProjection(id));
  }

  private hardDelete(id: string, expectedKind: SearchContentKind): void {
    this.assertTrashed(id, expectedKind);
    this.projection().remove(expectedKind, id);
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
         id, name, source_memo_id, version, created_at, updated_at
       ) VALUES (?, ?, ?, 1, ?, ?)`,
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
      `UPDATE topics
       SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
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
             AND trashed_at IS NULL AND trashed_with_topic_id IS NULL
           LIMIT ?`,
          topicId,
          MAX_TOPIC_DOCUMENTS_PER_COMMAND + 1,
        )
        .toArray();
      this.assertTopicDocumentLimit(documents.length);
      this.storage.sql.exec(
        `UPDATE topics
         SET trashed_at = ?, purge_after = ?, version = version + 1,
             updated_at = ? WHERE id = ?`,
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
        this.projection().remove("document", document.id);
      }
      return;
    }
    const documents = this.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM content
         WHERE kind = 'document' AND trashed_with_topic_id = ?
         LIMIT ?`,
        topicId,
        MAX_TOPIC_DOCUMENTS_PER_COMMAND + 1,
      )
      .toArray();
    this.assertTopicDocumentLimit(documents.length);
    this.storage.sql.exec(
      `UPDATE topics
       SET trashed_at = NULL, purge_after = NULL, version = version + 1,
           updated_at = ? WHERE id = ?`,
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
      this.projection().upsert(this.readProjection(document.id));
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
         WHERE kind = 'document' AND trashed_with_topic_id = ?
         LIMIT ?`,
        topicId,
        MAX_TOPIC_DOCUMENTS_PER_COMMAND + 1,
      )
      .toArray();
    this.assertTopicDocumentLimit(setDocuments.length);
    for (const document of setDocuments) {
      this.projection().remove("document", document.id);
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
    const normalized = this.normalizeSources(sourceMemoIds);
    for (
      let start = 0;
      start < normalized.length;
      start += SOURCE_INSERT_BATCH
    ) {
      const batch = normalized.slice(start, start + SOURCE_INSERT_BATCH);
      const values = batch.map(() => "(?, ?, '', ?)").join(", ");
      this.storage.sql.exec(
        `INSERT INTO content_sources(content_id, memo_id, label, linked_at)
         VALUES ${values}`,
        ...batch.flatMap((memoId) => [documentId, memoId, linkedAt]),
      );
    }
  }

  private addRevision(
    contentId: string,
    title: string,
    body: string,
    timestamp: number,
    actorId?: string,
    changeReason?: string,
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
         content_id, version, title, body, actor_id, change_reason, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      contentId,
      version,
      title,
      body,
      actorId ?? "local-user",
      changeReason ?? null,
      timestamp,
    );
    this.storage.sql.exec(
      "UPDATE content SET latest_revision_version = ? WHERE id = ?",
      version,
      contentId,
    );
  }

  private assertExpectedVersion(id: string, expected?: number): void {
    if (expected === undefined) return;
    const row = this.storage.sql
      .exec<{ version: number }>("SELECT version FROM content WHERE id = ?", id)
      .toArray()[0];
    if (!row || row.version !== expected) {
      throw new ConflictError(
        "CONTENT_VERSION_CONFLICT",
        "Content version did not match",
      );
    }
  }

  private assertTopicExpectedVersion(topicId: string, expected?: number): void {
    if (expected === undefined) return;
    const row = this.storage.sql
      .exec<{ version: number }>(
        "SELECT version FROM topics WHERE id = ?",
        topicId,
      )
      .toArray()[0];
    if (!row || row.version !== expected) {
      throw new ConflictError(
        "TOPIC_VERSION_CONFLICT",
        "Topic version did not match",
      );
    }
  }

  private normalizeSources(
    sourceMemoIds: readonly string[],
  ): readonly string[] {
    return [...new Set(sourceMemoIds)].sort();
  }

  private documentIsUnchanged(
    document: DocumentWriteDto,
    sourceMemoIds: readonly string[],
  ): boolean {
    const current = this.storage.sql
      .exec<{ title: string; body: string; topic_id: string | null }>(
        "SELECT title, body, topic_id FROM content WHERE id = ?",
        document.id,
      )
      .one();
    if (
      current.title !== document.title ||
      current.body !== document.body ||
      current.topic_id !== document.topicId
    ) {
      return false;
    }
    const currentSources = this.storage.sql
      .exec<{ memo_id: string }>(
        "SELECT memo_id FROM content_sources WHERE content_id = ? ORDER BY memo_id",
        document.id,
      )
      .toArray()
      .map(({ memo_id }) => memo_id);
    return JSON.stringify(currentSources) === JSON.stringify(sourceMemoIds);
  }

  private enqueueRetention(
    kind: SearchContentKind | "topic",
    id: string,
    trashedAt: number,
  ): void {
    const jobKind = kind === "topic" ? "purge-topic" : "purge-trash";
    const jobId = `purge-${jobKind}:${kind}:${id}:${trashedAt}`;
    new DurableJobStore(this.storage).enqueueInTransaction({
      id: jobId,
      kind: jobKind,
      payload: { id, kind, trashedAt },
      nextRunAt: trashedAt + this.retentionDays() * DAY_MS,
      providerIdempotencyKey: jobId,
      now: trashedAt,
    });
  }

  private assertTopicDocumentLimit(count: number): void {
    if (count > MAX_TOPIC_DOCUMENTS_PER_COMMAND) {
      throw new ConflictError(
        SearchErrorCode.ContentLimitExceeded,
        `A topic command may affect at most ${MAX_TOPIC_DOCUMENTS_PER_COMMAND} documents`,
      );
    }
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
    const normalized = this.normalizeSources(sourceMemoIds);
    if (normalized.length > MAX_SOURCES) {
      throw new ConflictError(
        SearchErrorCode.SourceLimitExceeded,
        `A document may have at most ${MAX_SOURCES} source memos`,
      );
    }
    if (normalized.length === 0) return;
    const placeholders = normalized.map(() => "?").join(", ");
    const found = this.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM content
         WHERE id IN (${placeholders}) AND kind = 'memo' AND trashed_at IS NULL`,
        ...normalized,
      )
      .toArray();
    if (found.length !== normalized.length) {
      throw new NotFoundError(
        SearchErrorCode.SourceNotFound,
        "Source memo was not found",
      );
    }
  }

  private validateDocument(document: DocumentWriteDto): void {
    if (document.title.trim().length === 0) {
      throw new BusinessRuleError(
        SearchErrorCode.EmptyDocumentTitle,
        "Document title must not be empty",
      );
    }
    if (/[\r\n]/u.test(document.title)) {
      throw new BusinessRuleError(
        SearchErrorCode.DocumentTitleMultiline,
        "Document title must be a single line",
      );
    }
    if ([...document.title].length > MAX_DOCUMENT_TITLE_CODE_POINTS) {
      throw new BusinessRuleError(
        SearchErrorCode.DocumentTitleTooLong,
        `Document title may have at most ${MAX_DOCUMENT_TITLE_CODE_POINTS} characters`,
      );
    }
    this.validateText(document.title, document.body);
    if (document.topicId.length === 0) {
      throw new ConflictError(
        SearchErrorCode.TopicRequired,
        "Document must belong to a topic",
      );
    }
  }

  private validateMemo(body: string): void {
    if (body.trim().length === 0) {
      throw new BusinessRuleError(
        SearchErrorCode.EmptyMemoBody,
        "Memo body must not be empty",
      );
    }
    if ([...body].length > MAX_MEMO_BODY_CODE_POINTS) {
      throw new BusinessRuleError(
        SearchErrorCode.MemoBodyTooLong,
        `Memo body may have at most ${MAX_MEMO_BODY_CODE_POINTS} characters`,
      );
    }
    this.validateText("", body);
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
