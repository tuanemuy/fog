import { DurableObject } from "cloudflare:workers";
import { payloadDigest } from "@repo/core/adapters/cloudflare/user-data/canonical";
import { DurableJobStore } from "@repo/core/adapters/cloudflare/user-data/jobs";
import { migrateUserData } from "@repo/core/adapters/cloudflare/user-data/schema";
import { Fts5SearchAdapter } from "@repo/core/adapters/cloudflare/user-data/searchIndex";
import { UserDataSemanticCommit } from "@repo/core/adapters/cloudflare/user-data/semanticCommit";
import {
  ConflictError,
  NotFoundError,
  SystemError,
  ValidationError,
} from "@repo/core/application/errors";
import type { RpcResult } from "@repo/core/application/identity/contracts";
import type {
  SearchContentKind,
  SearchPage,
  SearchQuery,
  SemanticCommand,
  SemanticCommitResult,
} from "@repo/core/application/search/contracts";
import {
  SEARCH_RPC_VERSION,
  SearchErrorCode,
} from "@repo/core/application/search/contracts";
import { BusinessRuleError } from "@repo/core/domain/error";

type StateEnv = Record<string, never>;

type UserDataProfile = Readonly<{
  userId: string;
  trashRetentionDays: number;
}>;

type RetentionKind = SearchContentKind | "topic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => key in value) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isTimestamp(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 8_640_000_000_000_000
  );
}

function isMemo(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "body", "timestamp"]) &&
    isId(value.id) &&
    typeof value.body === "string" &&
    isTimestamp(value.timestamp)
  );
}

function isDocument(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "title",
      "body",
      "timestamp",
      "topicId",
      "sourceMemoIds",
    ]) &&
    isId(value.id) &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    isTimestamp(value.timestamp) &&
    isId(value.topicId) &&
    Array.isArray(value.sourceMemoIds) &&
    value.sourceMemoIds.length <= 100 &&
    value.sourceMemoIds.every(isId)
  );
}

function isTopic(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "name", "timestamp"], ["sourceMemoId"]) &&
    isId(value.id) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    new TextEncoder().encode(value.name).byteLength <= 1_024 &&
    isTimestamp(value.timestamp) &&
    (value.sourceMemoId === undefined || isId(value.sourceMemoId))
  );
}

export function shouldMoveAlarm(
  current: number | null,
  target: number,
): boolean {
  return current === null || target < current;
}

export class UserDataDurableObject extends DurableObject<StateEnv> {
  constructor(ctx: DurableObjectState, env: StateEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrateUserData(ctx.storage, Date.now());
      await this.ensureAlarm();
    });
  }

  async initialize(input: {
    operationId: string;
    userId: string;
    now: number;
  }): Promise<RpcResult<UserDataProfile>> {
    return this.rpc(async () => {
      this.ctx.storage.transactionSync(() => {
        const digest = payloadDigest({
          userId: input.userId,
          now: input.now,
        });
        const operation = this.ctx.storage.sql
          .exec<{ payload_digest: string }>(
            `SELECT payload_digest FROM idempotency
             WHERE namespace = 'initialize' AND operation_id = ?`,
            input.operationId,
          )
          .toArray()[0];
        if (operation && operation.payload_digest !== digest) {
          throw new ConflictError(
            SearchErrorCode.IdempotencyConflict,
            "Initialization operation has a different payload",
          );
        }
        const existing = this.ctx.storage.sql
          .exec<{ user_id: string }>(
            "SELECT user_id FROM profile WHERE singleton = 1",
          )
          .toArray()[0];
        if (existing && existing.user_id !== input.userId) {
          throw new Error("USER_DATA_OWNER_MISMATCH");
        }
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO profile(
           singleton, user_id, created_at, updated_at
         ) VALUES (1, ?, ?, ?)`,
          input.userId,
          input.now,
          input.now,
        );
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO settings(
           singleton, trash_retention_days, version, updated_at
         ) VALUES (1, 30, 1, ?)`,
          input.now,
        );
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO idempotency(
           namespace, operation_id, command_kind, payload_digest,
           result_json, completed_at
         ) VALUES ('initialize', ?, 'initialize', ?, '{"ok":true}', ?)`,
          input.operationId,
          digest,
          input.now,
        );
      });
      await this.ensureAlarm();
      return this.profile();
    });
  }

  async getProfile(): Promise<RpcResult<UserDataProfile>> {
    await this.ensureAlarm();
    const row = this.ctx.storage.sql
      .exec<{ user_id: string; trash_retention_days: number }>(
        `SELECT p.user_id, s.trash_retention_days
         FROM profile p JOIN settings s ON s.singleton = 1
         WHERE p.singleton = 1`,
      )
      .toArray()[0];
    if (!row) {
      return {
        ok: false,
        error: {
          kind: "not-found",
          code: "USER_DATA_NOT_FOUND",
          message: "User data was not found",
          retryable: false,
        },
      };
    }
    return {
      ok: true,
      value: {
        userId: row.user_id,
        trashRetentionDays: row.trash_retention_days,
      },
    };
  }

  async commit(
    command: SemanticCommand,
  ): Promise<RpcResult<SemanticCommitResult>> {
    return this.rpc(async () => {
      this.assertSemanticCommand(command);
      const commit = new UserDataSemanticCommit(
        this.ctx.storage,
        () => this.profile().trashRetentionDays,
      );
      const result = commit.commit(command);
      this.scheduleRetention(command);
      await this.ensureAlarm();
      return result;
    });
  }

  async search(query: SearchQuery): Promise<RpcResult<SearchPage>> {
    return this.rpc(async () => {
      await this.ensureAlarm();
      this.assertSearchQuery(query);
      const page = this.ctx.storage.transactionSync(() => {
        const adapter = new Fts5SearchAdapter(this.ctx.storage.sql);
        return adapter.query(query);
      });
      return page;
    });
  }

  async updateTrashRetention(input: {
    version: typeof SEARCH_RPC_VERSION;
    operationId: string;
    retentionDays: number;
    updatedAt: number;
  }): Promise<RpcResult<UserDataProfile>> {
    return this.rpc(async () => {
      if (
        input.version !== SEARCH_RPC_VERSION ||
        !isId(input.operationId) ||
        !Number.isSafeInteger(input.retentionDays) ||
        input.retentionDays < 1 ||
        input.retentionDays > 36_500 ||
        !isTimestamp(input.updatedAt)
      ) {
        throw new ValidationError(
          "TRASH_RETENTION_INVALID",
          "Trash retention update is invalid",
        );
      }
      this.ctx.storage.transactionSync(() => {
        const digest = payloadDigest({
          version: input.version,
          retentionDays: input.retentionDays,
          updatedAt: input.updatedAt,
        });
        const existing = this.ctx.storage.sql
          .exec<{ payload_digest: string }>(
            `SELECT payload_digest FROM idempotency
             WHERE namespace = 'settings' AND operation_id = ?`,
            input.operationId,
          )
          .toArray()[0];
        if (existing && existing.payload_digest !== digest) {
          throw new ConflictError(
            SearchErrorCode.IdempotencyConflict,
            "Settings operation has a different payload",
          );
        }
        if (existing) return;
        const retentionMs = input.retentionDays * 86_400_000;
        this.ctx.storage.sql.exec(
          `UPDATE settings
           SET trash_retention_days = ?, version = version + 1, updated_at = ?
           WHERE singleton = 1`,
          input.retentionDays,
          input.updatedAt,
        );
        this.ctx.storage.sql.exec(
          "UPDATE trash SET purge_after = trashed_at + ?",
          retentionMs,
        );
        this.ctx.storage.sql.exec(
          `UPDATE topics SET purge_after = trashed_at + ?
           WHERE trashed_at IS NOT NULL`,
          retentionMs,
        );
        this.ctx.storage.sql.exec(
          `UPDATE jobs
           SET next_run_at =
             CAST(json_extract(payload_json, '$.trashedAt') AS INTEGER) + ?,
             updated_at = ?
           WHERE status = 'pending'
             AND kind IN ('purge-trash', 'purge-topic')`,
          retentionMs,
          input.updatedAt,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO idempotency(
             namespace, operation_id, command_kind, payload_digest,
             result_json, completed_at
           ) VALUES ('settings', ?, 'update-trash-retention', ?, '{"ok":true}', ?)`,
          input.operationId,
          digest,
          input.updatedAt,
        );
      });
      await this.ensureAlarm();
      return this.profile();
    });
  }

  async deleteAll(input: {
    expectedUserId: string;
  }): Promise<RpcResult<{ deleted: true }>> {
    let profile: UserDataProfile;
    try {
      profile = this.profile();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("no such table: profile")
      ) {
        return { ok: true, value: { deleted: true } };
      }
      throw error;
    }
    if (profile.userId !== input.expectedUserId) {
      return {
        ok: false,
        error: {
          kind: "conflict",
          code: "USER_DATA_OWNER_MISMATCH",
          message: "User data owner did not match",
          retryable: false,
        },
      };
    }
    await this.ctx.storage.deleteAll();
    return { ok: true, value: { deleted: true } };
  }

  async exportPage(input: { cursor?: string; limit?: number }): Promise<
    RpcResult<{
      items: readonly Record<string, unknown>[];
      nextCursor?: string;
    }>
  > {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const cursor = input.cursor ?? "";
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        kind: string;
        title: string;
        body: string;
        topic_id: string | null;
        trashed_at: number | null;
        updated_at: number;
      }>(
        `SELECT id, kind, title, body, topic_id, trashed_at, updated_at
         FROM content WHERE id > ? ORDER BY id LIMIT ?`,
        cursor,
        limit + 1,
      )
      .toArray();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      ok: true,
      value: {
        items: page,
        ...(rows.length > limit && last ? { nextCursor: last.id } : {}),
      },
    };
  }

  async operatorGetCurrentBookmark(): Promise<string> {
    return this.ctx.storage.getCurrentBookmark();
  }

  async operatorRestoreBookmark(bookmark: string): Promise<string> {
    return this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
  }

  async operatorRestartSession(): Promise<void> {
    setTimeout(() => this.ctx.abort("PITR_SESSION_RESTART"), 0);
  }

  async operatorVerifyRestoredSession(bookmark: string): Promise<string> {
    if (bookmark.length === 0) throw new Error("PITR_BOOKMARK_REQUIRED");
    const current = await this.ctx.storage.getCurrentBookmark();
    if (current < bookmark) throw new Error("PITR_RESTORE_NOT_APPLIED");
    return current;
  }

  async alarm(): Promise<void> {
    const startedAt = Date.now();
    const ownerToken = crypto.randomUUID();
    const store = new DurableJobStore(this.ctx.storage);
    let processed = 0;
    while (processed < 25 && Date.now() - startedAt < 10_000) {
      const claimedAt = Date.now();
      const job = store.claim({
        now: claimedAt,
        leaseMs: 60_000,
        ownerToken,
        limit: 1,
      })[0];
      if (!job) break;
      processed += 1;
      try {
        this.executeJob(job.kind, job.payload, Date.now());
        store.complete(job.id, ownerToken, Date.now());
      } catch (error) {
        const failedAt = Date.now();
        store.retryOrPoison({
          id: job.id,
          ownerToken,
          now: failedAt,
          maxAttempts: 5,
          retryAt: failedAt + Math.min(2 ** job.attempt * 1_000, 300_000),
          reason: error instanceof Error ? error.message : "UNKNOWN_JOB_ERROR",
        });
      }
    }
    await this.ensureAlarm();
  }

  private profile(): UserDataProfile {
    const row = this.ctx.storage.sql
      .exec<{ user_id: string; trash_retention_days: number }>(
        `SELECT p.user_id, s.trash_retention_days
         FROM profile p JOIN settings s ON s.singleton = 1
         WHERE p.singleton = 1`,
      )
      .one();
    return {
      userId: row.user_id,
      trashRetentionDays: row.trash_retention_days,
    };
  }

  private scheduleRetention(command: SemanticCommand): void {
    let id: string;
    let kind: RetentionKind;
    let trashedAt: number;
    switch (command.type) {
      case "trash-memo":
        id = command.memoId;
        kind = "memo";
        trashedAt = command.trashedAt;
        break;
      case "trash-document":
        id = command.documentId;
        kind = "document";
        trashedAt = command.trashedAt;
        break;
      case "trash-topic":
        id = command.topicId;
        trashedAt = command.trashedAt;
        kind = "topic";
        break;
      default:
        return;
    }
    const nextRunAt =
      trashedAt + this.profile().trashRetentionDays * 86_400_000;
    new DurableJobStore(this.ctx.storage).enqueue({
      id: `purge-${kind === "topic" ? "topic" : "trash"}:${kind}:${id}:${trashedAt}`,
      kind: kind === "topic" ? "purge-topic" : "purge-trash",
      payload: { id, kind, trashedAt },
      nextRunAt,
      providerIdempotencyKey: `purge-${kind === "topic" ? "topic" : "trash"}:${kind}:${id}:${trashedAt}`,
      now: trashedAt,
    });
  }

  private executeJob(kind: string, payload: unknown, now: number): void {
    if (
      (kind !== "purge-trash" && kind !== "purge-topic") ||
      typeof payload !== "object" ||
      payload === null ||
      !("id" in payload) ||
      typeof payload.id !== "string" ||
      !("kind" in payload) ||
      (payload.kind !== "memo" &&
        payload.kind !== "document" &&
        payload.kind !== "topic")
    ) {
      throw new Error("UNSUPPORTED_JOB");
    }
    if ((kind === "purge-topic") !== (payload.kind === "topic")) {
      throw new Error("UNSUPPORTED_JOB");
    }
    const contentId = payload.id;
    this.ctx.storage.transactionSync(() => {
      if (payload.kind === "topic") {
        const due = this.ctx.storage.sql
          .exec<{ id: string }>(
            `SELECT id FROM topics
             WHERE id = ? AND trashed_at IS NOT NULL AND purge_after <= ?`,
            contentId,
            now,
          )
          .toArray()[0];
        if (!due) return;
        const setDocuments = this.ctx.storage.sql
          .exec<{ id: string }>(
            `SELECT id FROM content
             WHERE kind = 'document' AND trashed_with_topic_id = ?`,
            contentId,
          )
          .toArray();
        const projection = new Fts5SearchAdapter(this.ctx.storage.sql);
        for (const document of setDocuments) {
          projection.apply({
            type: "remove",
            entityType: "document",
            id: document.id,
          });
        }
        this.ctx.storage.sql.exec(
          `DELETE FROM content
           WHERE kind = 'document' AND trashed_with_topic_id = ?`,
          contentId,
        );
        this.ctx.storage.sql.exec(
          `UPDATE content SET topic_id = NULL
           WHERE kind = 'document' AND topic_id = ?`,
          contentId,
        );
        this.ctx.storage.sql.exec("DELETE FROM topics WHERE id = ?", contentId);
        return;
      }
      const due = this.ctx.storage.sql
        .exec<{ content_kind: SearchContentKind }>(
          `SELECT content_kind FROM trash
           WHERE content_id = ? AND purge_after <= ?`,
          contentId,
          now,
        )
        .toArray()[0];
      if (!due) return;
      new Fts5SearchAdapter(this.ctx.storage.sql).apply({
        type: "remove",
        entityType: due.content_kind,
        id: contentId,
      });
      this.ctx.storage.sql.exec("DELETE FROM content WHERE id = ?", contentId);
    });
  }

  private async ensureAlarm(): Promise<void> {
    const next = new DurableJobStore(this.ctx.storage).nextRunAt();
    if (next === null) return;
    const target = Math.max(next, Date.now() + 1_000);
    const current = await this.ctx.storage.getAlarm();
    if (shouldMoveAlarm(current, target)) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  private assertSemanticCommand(
    command: unknown,
  ): asserts command is SemanticCommand {
    const invalid = () => {
      throw new ValidationError(
        "SEMANTIC_COMMAND_INVALID",
        "Semantic command is invalid",
      );
    };
    if (
      !isRecord(command) ||
      command.version !== SEARCH_RPC_VERSION ||
      !isId(command.operationId) ||
      typeof command.type !== "string"
    ) {
      throw new ValidationError(
        "SEMANTIC_COMMAND_INVALID",
        "Semantic command is invalid",
      );
    }
    const base = ["version", "operationId", "type"] as const;
    let valid = false;
    switch (command.type) {
      case "create-memo":
      case "update-memo":
      case "restore-memo":
        valid = hasOnlyKeys(command, [...base, "memo"]) && isMemo(command.memo);
        break;
      case "trash-memo":
        valid =
          hasOnlyKeys(command, [...base, "memoId", "trashedAt"]) &&
          isId(command.memoId) &&
          isTimestamp(command.trashedAt);
        break;
      case "remove-memo":
        valid =
          hasOnlyKeys(command, [...base, "memoId", "removedAt"]) &&
          isId(command.memoId) &&
          isTimestamp(command.removedAt);
        break;
      case "create-document":
      case "update-document":
      case "restore-document":
        valid =
          hasOnlyKeys(command, [...base, "document"]) &&
          isDocument(command.document);
        break;
      case "trash-document":
        valid =
          hasOnlyKeys(command, [...base, "documentId", "trashedAt"]) &&
          isId(command.documentId) &&
          isTimestamp(command.trashedAt);
        break;
      case "remove-document":
        valid =
          hasOnlyKeys(command, [...base, "documentId", "removedAt"]) &&
          isId(command.documentId) &&
          isTimestamp(command.removedAt);
        break;
      case "create-topic":
        valid =
          hasOnlyKeys(command, [...base, "topic"]) && isTopic(command.topic);
        break;
      case "set-topic-archived":
        valid =
          hasOnlyKeys(command, [
            ...base,
            "topicId",
            "archivedAt",
            "updatedAt",
          ]) &&
          isId(command.topicId) &&
          (command.archivedAt === null || isTimestamp(command.archivedAt)) &&
          isTimestamp(command.updatedAt);
        break;
      case "trash-topic":
        valid =
          hasOnlyKeys(command, [...base, "topicId", "trashedAt"]) &&
          isId(command.topicId) &&
          isTimestamp(command.trashedAt);
        break;
      case "restore-topic":
        valid =
          hasOnlyKeys(command, [...base, "topicId", "restoredAt"]) &&
          isId(command.topicId) &&
          isTimestamp(command.restoredAt);
        break;
      case "remove-topic":
        valid =
          hasOnlyKeys(command, [...base, "topicId", "removedAt"]) &&
          isId(command.topicId) &&
          isTimestamp(command.removedAt);
        break;
      default:
        invalid();
    }
    if (!valid) {
      invalid();
    }
  }

  private assertSearchQuery(query: unknown): asserts query is SearchQuery {
    if (
      !isRecord(query) ||
      !hasOnlyKeys(
        query,
        ["version", "keyword"],
        ["topicId", "page", "limit", "cursor"],
      ) ||
      query.version !== SEARCH_RPC_VERSION ||
      typeof query.keyword !== "string" ||
      (query.topicId !== undefined && !isId(query.topicId)) ||
      (query.page !== undefined && typeof query.page !== "number") ||
      (query.limit !== undefined && typeof query.limit !== "number") ||
      (query.cursor !== undefined && typeof query.cursor !== "string")
    ) {
      throw new ValidationError(
        "SEARCH_QUERY_INVALID",
        "Search query is invalid",
      );
    }
  }

  private async rpc<T>(operation: () => Promise<T>): Promise<RpcResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      if (error instanceof BusinessRuleError) {
        return {
          ok: false,
          error: {
            kind: "validation",
            code: error.code,
            message: error.message,
            retryable: false,
          },
        };
      }
      if (error instanceof ValidationError) {
        return {
          ok: false,
          error: {
            kind: "validation",
            code: error.code,
            message: error.message,
            retryable: false,
          },
        };
      }
      if (error instanceof ConflictError) {
        return {
          ok: false,
          error: {
            kind: "conflict",
            code: error.code,
            message: error.message,
            retryable: false,
          },
        };
      }
      if (error instanceof NotFoundError) {
        return {
          ok: false,
          error: {
            kind: "not-found",
            code: error.code,
            message: error.message,
            retryable: false,
          },
        };
      }
      if (error instanceof SystemError) {
        return {
          ok: false,
          error: {
            kind: "infrastructure",
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          },
        };
      }
      throw error;
    }
  }
}
