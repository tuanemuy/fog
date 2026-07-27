import { DurableObject } from "cloudflare:workers";
import type { PitrRestoreProof } from "@repo/core/adapters/cloudflare/pitrOperator";
import { sqliteErrorCode } from "@repo/core/adapters/cloudflare/sql";
import { payloadDigest } from "@repo/core/adapters/cloudflare/user-data/canonical";
import { DurableJobStore } from "@repo/core/adapters/cloudflare/user-data/jobs";
import { migrateUserData } from "@repo/core/adapters/cloudflare/user-data/schema";
import { Fts5SearchAdapter } from "@repo/core/adapters/cloudflare/user-data/searchIndex";
import {
  ConflictError,
  NotFoundError,
  SystemError,
  SystemErrorCode,
  ValidationError,
} from "@repo/core/application/errors";
import type {
  IdentityRpcMutation,
  IdentityRpcQuery,
  RpcResult,
} from "@repo/core/application/identity/contracts";
import type {
  SearchContentKind,
  SearchPage,
  SearchRpcQuery,
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

export function shouldMoveAlarm(
  current: number | null,
  target: number,
): boolean {
  return current === null || target < current;
}

export class UserDataDurableObject extends DurableObject<StateEnv> {
  private readonly pitrSessionId = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: StateEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrateUserData(ctx.storage, Date.now());
      await this.ensureAlarm();
    });
  }

  async identityInitializeV1(
    input: IdentityRpcMutation<{ userId: string; now: number }>,
  ): Promise<RpcResult<UserDataProfile>> {
    return this.rpc(async () => {
      this.assertIdentityMutation(input);
      this.ctx.storage.transactionSync(() => {
        const digest = payloadDigest({
          userId: input.payload.userId,
          now: input.payload.now,
        });
        const deleted = this.ctx.storage.sql
          .exec<{ operation_id: string }>(
            "SELECT operation_id FROM user_data_delete_markers LIMIT 1",
          )
          .toArray()[0];
        if (deleted) {
          throw new ConflictError(
            "USER_DATA_DELETED",
            "Deleted User Data cannot be initialized again",
          );
        }
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
        if (existing && existing.user_id !== input.payload.userId) {
          throw new ConflictError(
            "USER_DATA_OWNER_MISMATCH",
            "User data owner did not match",
          );
        }
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO profile(
           singleton, user_id, created_at, updated_at
         ) VALUES (1, ?, ?, ?)`,
          input.payload.userId,
          input.payload.now,
          input.payload.now,
        );
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO settings(
           singleton, trash_retention_days, version, updated_at
         ) VALUES (1, 30, 0, ?)`,
          input.payload.now,
        );
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO idempotency(
           namespace, operation_id, command_kind, payload_digest,
           result_json, completed_at
         ) VALUES ('initialize', ?, 'initialize', ?, '{"ok":true}', ?)`,
          input.operationId,
          digest,
          input.payload.now,
        );
      });
      await this.ensureAlarm();
      return this.profile();
    });
  }

  async identityGetProfileV1(
    input: IdentityRpcQuery<{ userId: string }>,
  ): Promise<RpcResult<UserDataProfile>> {
    return this.rpc(async () => {
      if (
        input.version !== 1 ||
        !isRecord(input.payload) ||
        !hasOnlyKeys(input.payload, ["userId"]) ||
        !isId(input.payload.userId)
      ) {
        throw new ValidationError(
          "IDENTITY_RPC_INVALID",
          "Identity query is invalid",
        );
      }
      await this.ensureAlarm();
      const row = this.ctx.storage.sql
        .exec<{ user_id: string; trash_retention_days: number }>(
          `SELECT p.user_id, s.trash_retention_days
           FROM profile p JOIN settings s ON s.singleton = 1
           WHERE p.singleton = 1`,
        )
        .toArray()[0];
      if (!row) {
        throw new NotFoundError(
          "USER_DATA_NOT_FOUND",
          "User data was not found",
        );
      }
      if (row.user_id !== input.payload.userId) {
        throw new ConflictError(
          "USER_DATA_OWNER_MISMATCH",
          "User data owner did not match",
        );
      }
      return {
        userId: row.user_id,
        trashRetentionDays: row.trash_retention_days,
      };
    });
  }

  async identityGetStatusV1(
    input: IdentityRpcQuery<{ userId: string }>,
  ): Promise<RpcResult<{ initialized: boolean; deleted: boolean }>> {
    return this.rpc(() => {
      if (
        input.version !== 1 ||
        !isRecord(input.payload) ||
        !hasOnlyKeys(input.payload, ["userId"]) ||
        !isId(input.payload.userId)
      ) {
        throw new ValidationError(
          "IDENTITY_RPC_INVALID",
          "Identity query is invalid",
        );
      }
      const deleted = this.ctx.storage.sql
        .exec<{ expected_user_id: string }>(
          "SELECT expected_user_id FROM user_data_delete_markers LIMIT 1",
        )
        .toArray()[0];
      if (deleted) {
        return {
          initialized: false,
          deleted: deleted.expected_user_id === input.payload.userId,
        };
      }
      const profile = this.ctx.storage.sql
        .exec<{ user_id: string }>(
          "SELECT user_id FROM profile WHERE singleton = 1",
        )
        .toArray()[0];
      return {
        initialized: profile?.user_id === input.payload.userId,
        deleted: false,
      };
    });
  }

  async search(query: SearchRpcQuery): Promise<RpcResult<SearchPage>> {
    return this.rpc(async () => {
      await this.ensureAlarm();
      this.assertSearchQuery(query);
      const page = this.ctx.storage.transactionSync(() => {
        const adapter = new Fts5SearchAdapter(this.ctx.storage.sql);
        return adapter.querySync({
          keyword: query.keyword,
          ...(query.topicId === undefined ? {} : { topicId: query.topicId }),
          pagination: {
            ...(query.page === undefined ? {} : { page: query.page }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          },
        });
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
           SET next_run_at = CASE
             WHEN subject_kind = 'topic' THEN (
               SELECT purge_after FROM topics WHERE id = jobs.subject_id
             )
             ELSE (
               SELECT purge_after FROM trash WHERE content_id = jobs.subject_id
             )
           END,
             updated_at = ?
           WHERE status IN ('pending', 'leased')
             AND kind IN ('purge-trash', 'purge-topic')
             AND subject_id IS NOT NULL
             AND (
               (
                 subject_kind = 'topic'
                 AND EXISTS (
                   SELECT 1 FROM topics WHERE id = jobs.subject_id
                 )
               )
               OR (
                 subject_kind IN ('memo', 'document')
                 AND EXISTS (
                   SELECT 1 FROM trash WHERE content_id = jobs.subject_id
                 )
               )
             )`,
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

  async identityDeleteAllV1(
    input: IdentityRpcMutation<{ userId: string }>,
  ): Promise<RpcResult<{ deleted: true }>> {
    return this.rpc(async () => {
      this.assertIdentityMutation(input, false);
      const digest = payloadDigest(input.payload);
      this.ctx.storage.transactionSync(() => {
        const marker = this.ctx.storage.sql
          .exec<{
            expected_user_id: string;
            payload_digest: string;
          }>(
            `SELECT expected_user_id, payload_digest
             FROM user_data_delete_markers WHERE operation_id = ?`,
            input.operationId,
          )
          .toArray()[0];
        if (marker) {
          if (
            marker.expected_user_id !== input.payload.userId ||
            marker.payload_digest !== digest
          ) {
            throw new ConflictError(
              SearchErrorCode.IdempotencyConflict,
              "Deletion operation has a different payload",
            );
          }
          return;
        }
        const owner = this.ctx.storage.sql
          .exec<{ user_id: string }>(
            "SELECT user_id FROM profile WHERE singleton = 1",
          )
          .toArray()[0];
        const deletedOwner = this.ctx.storage.sql
          .exec<{ expected_user_id: string }>(
            "SELECT expected_user_id FROM user_data_delete_markers LIMIT 1",
          )
          .toArray()[0];
        if (
          (owner && owner.user_id !== input.payload.userId) ||
          (deletedOwner &&
            deletedOwner.expected_user_id !== input.payload.userId)
        ) {
          throw new ConflictError(
            "USER_DATA_OWNER_MISMATCH",
            "User data owner did not match",
          );
        }
        this.clearUserDataInTransaction();
        this.ctx.storage.sql.exec(
          `INSERT INTO user_data_delete_markers(
             operation_id, expected_user_id, payload_digest, completed_at
           ) VALUES (?, ?, ?, ?)`,
          input.operationId,
          input.payload.userId,
          digest,
          Date.now(),
        );
      });
      await this.ctx.storage.deleteAlarm();
      return { deleted: true };
    });
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

  async operatorPrepareRestoreProof(
    proofId: string,
  ): Promise<{ sessionId: string }> {
    if (proofId.length === 0 || proofId.length > 128) {
      throw new TypeError("PITR_PROOF_ID_INVALID");
    }
    await this.ctx.storage.put(`pitr-proof:${proofId}`, this.pitrSessionId);
    return { sessionId: this.pitrSessionId };
  }

  async operatorRestoreBookmark(bookmark: string): Promise<string> {
    return this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
  }

  async operatorRestartSession(): Promise<void> {
    this.ctx.abort("PITR_RESTART_REQUESTED");
  }

  async operatorVerifyRestoredSession(
    bookmark: string,
    proof: PitrRestoreProof,
  ): Promise<string> {
    if (
      bookmark.length === 0 ||
      proof.id.length === 0 ||
      proof.previousSessionId.length === 0 ||
      proof.undoBookmark.length === 0
    ) {
      throw new Error("PITR_PROOF_REQUIRED");
    }
    if (proof.previousSessionId === this.pitrSessionId) {
      throw new Error("PITR_SESSION_NOT_RESTARTED");
    }
    const sentinel = await this.ctx.storage.get(`pitr-proof:${proof.id}`);
    if (sentinel !== undefined) {
      throw new Error("PITR_RESTORE_SENTINEL_PRESENT");
    }
    const current = await this.ctx.storage.getCurrentBookmark();
    if (current < proof.undoBookmark || current < bookmark) {
      throw new Error("PITR_RESTORE_NOT_APPLIED");
    }
    return current;
  }

  async alarm(): Promise<void> {
    try {
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
          const execution = this.executeJob(job.kind, job.payload, Date.now());
          if (execution.deferUntil === undefined) {
            store.complete(job.id, ownerToken, Date.now());
          } else {
            store.defer(job.id, ownerToken, Date.now(), execution.deferUntil);
            break;
          }
        } catch (error) {
          const failedAt = Date.now();
          store.retryOrPoison({
            id: job.id,
            ownerToken,
            now: failedAt,
            maxAttempts: 5,
            retryAt: failedAt + Math.min(2 ** job.attempt * 1_000, 300_000),
            reason:
              error instanceof Error ? error.message : "UNKNOWN_JOB_ERROR",
          });
        }
      }
    } finally {
      await this.ensureAlarm(true);
    }
  }

  protected profile(): UserDataProfile {
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

  private executeJob(
    kind: string,
    payload: unknown,
    now: number,
  ): Readonly<{ deferUntil?: number }> {
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
    return this.ctx.storage.transactionSync(() => {
      if (payload.kind === "topic") {
        const topic = this.ctx.storage.sql
          .exec<{ purge_after: number }>(
            `SELECT purge_after FROM topics
             WHERE id = ? AND trashed_at IS NOT NULL`,
            contentId,
          )
          .toArray()[0];
        if (!topic) return {};
        if (topic.purge_after > now) return { deferUntil: topic.purge_after };
        const setDocuments = this.ctx.storage.sql
          .exec<{ id: string }>(
            `SELECT id FROM content
             WHERE kind = 'document' AND trashed_with_topic_id = ?
             ORDER BY id LIMIT 50`,
            contentId,
          )
          .toArray();
        const projection = new Fts5SearchAdapter(this.ctx.storage.sql);
        for (const document of setDocuments) {
          projection.remove("document", document.id);
          this.ctx.storage.sql.exec(
            "DELETE FROM content WHERE id = ?",
            document.id,
          );
        }
        const remaining = this.ctx.storage.sql
          .exec<{ id: string }>(
            `SELECT id FROM content
             WHERE kind = 'document' AND trashed_with_topic_id = ? LIMIT 1`,
            contentId,
          )
          .toArray()[0];
        if (remaining) return { deferUntil: now + 1 };
        this.ctx.storage.sql.exec(
          `UPDATE content SET topic_id = NULL
           WHERE kind = 'document' AND topic_id = ?`,
          contentId,
        );
        this.ctx.storage.sql.exec("DELETE FROM topics WHERE id = ?", contentId);
        return {};
      }
      const trash = this.ctx.storage.sql
        .exec<{ content_kind: SearchContentKind; purge_after: number }>(
          `SELECT content_kind, purge_after FROM trash
           WHERE content_id = ?`,
          contentId,
        )
        .toArray()[0];
      if (!trash) return {};
      if (trash.purge_after > now) return { deferUntil: trash.purge_after };
      new Fts5SearchAdapter(this.ctx.storage.sql).remove(
        trash.content_kind,
        contentId,
      );
      this.ctx.storage.sql.exec("DELETE FROM content WHERE id = ?", contentId);
      return {};
    });
  }

  protected async ensureAlarm(reschedule = false): Promise<void> {
    const next = new DurableJobStore(this.ctx.storage).nextRunAt();
    if (next === null) return;
    const target = Math.max(next, Date.now() + 1_000);
    const current = await this.ctx.storage.getAlarm();
    if (reschedule || shouldMoveAlarm(current, target)) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  private assertSearchQuery(query: unknown): asserts query is SearchRpcQuery {
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

  private assertIdentityMutation(
    input: IdentityRpcMutation<{ userId: string; now?: number }>,
    requireNow = true,
  ): void {
    if (
      input.version !== 1 ||
      !isId(input.operationId) ||
      !isRecord(input.payload) ||
      !hasOnlyKeys(
        input.payload,
        requireNow ? ["userId", "now"] : ["userId"],
      ) ||
      !isId(input.payload.userId) ||
      (requireNow && !isTimestamp(input.payload.now))
    ) {
      throw new ValidationError(
        "IDENTITY_RPC_INVALID",
        "Identity mutation is invalid",
      );
    }
  }

  private clearUserDataInTransaction(): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO search_fts(search_fts) VALUES ('delete-all')",
    );
    for (const table of [
      "search_snapshot_items",
      "search_snapshots",
      "search_entries",
      "content_sources",
      "trash",
      "content_revisions",
      "content",
      "topics",
      "ai_client_connections",
      "jobs",
      "idempotency",
      "settings",
      "profile",
    ]) {
      this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
    }
  }

  protected async rpc<T>(
    operation: () => T | Promise<T>,
  ): Promise<RpcResult<T>> {
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
      const systemError =
        sqliteErrorCode(error) === "SQLITE_FULL"
          ? new SystemError(
              SystemErrorCode.StorageCapacityExceeded,
              "User data storage capacity was exceeded",
              error,
            )
          : new SystemError(
              SystemErrorCode.DatabaseError,
              "User data operation failed",
              error,
            );
      return {
        ok: false,
        error: {
          kind: "infrastructure",
          code: systemError.code,
          message: systemError.message,
          retryable: systemError.retryable,
        },
      };
    }
  }
}
