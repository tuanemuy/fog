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
  LegacySearchPage,
  LegacySearchQuery,
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

  async search<TQuery extends SearchQuery | LegacySearchQuery>(
    query: TQuery,
  ): Promise<
    RpcResult<TQuery extends SearchQuery ? SearchPage : LegacySearchPage>
  > {
    return this.rpc(async () => {
      await this.ensureAlarm();
      this.assertSearchQuery(query);
      const page = this.ctx.storage.transactionSync(() => {
        const adapter = new Fts5SearchAdapter(this.ctx.storage.sql);
        return "keyword" in query
          ? adapter.query(query)
          : adapter.search(query);
      });
      return page as TQuery extends SearchQuery ? SearchPage : LegacySearchPage;
    });
  }

  async deleteAll(input: {
    expectedUserId: string;
  }): Promise<RpcResult<{ deleted: true }>> {
    const profile = this.profile();
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
    let kind: SearchContentKind;
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
      case "trash-content": {
        id = command.id;
        trashedAt = command.trashedAt;
        kind = this.ctx.storage.sql
          .exec<{ kind: SearchContentKind }>(
            "SELECT kind FROM content WHERE id = ?",
            id,
          )
          .one().kind;
        break;
      }
      default:
        return;
    }
    const nextRunAt =
      trashedAt + this.profile().trashRetentionDays * 86_400_000;
    new DurableJobStore(this.ctx.storage).enqueue({
      id: `purge-trash:${kind}:${id}:${trashedAt}`,
      kind: "purge-trash",
      payload: { id, kind, trashedAt },
      nextRunAt,
      providerIdempotencyKey: `purge-trash:${kind}:${id}:${trashedAt}`,
      now: trashedAt,
    });
  }

  private executeJob(kind: string, payload: unknown, now: number): void {
    if (
      kind !== "purge-trash" ||
      typeof payload !== "object" ||
      payload === null ||
      !("id" in payload) ||
      typeof payload.id !== "string" ||
      !("kind" in payload) ||
      (payload.kind !== "memo" && payload.kind !== "document")
    ) {
      throw new Error("UNSUPPORTED_JOB");
    }
    const contentId = payload.id;
    this.ctx.storage.transactionSync(() => {
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
    if (current === null || current <= Date.now() || target < current) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  private assertSemanticCommand(command: SemanticCommand): void {
    if (
      typeof command !== "object" ||
      command === null ||
      typeof command.operationId !== "string" ||
      command.operationId.length === 0 ||
      typeof command.type !== "string" ||
      ("version" in command &&
        command.version !== undefined &&
        command.version !== SEARCH_RPC_VERSION)
    ) {
      throw new ValidationError(
        "SEMANTIC_COMMAND_INVALID",
        "Semantic command envelope is invalid",
      );
    }
  }

  private assertSearchQuery(
    query: SearchQuery | LegacySearchQuery,
  ): asserts query is SearchQuery | LegacySearchQuery {
    if (typeof query !== "object" || query === null) {
      throw new ValidationError(
        "SEARCH_QUERY_INVALID",
        "Search query is invalid",
      );
    }
    const keyword = "keyword" in query ? query.keyword : query.text;
    if (typeof keyword !== "string") {
      throw new ValidationError(
        "SEARCH_QUERY_INVALID",
        "Search keyword must be a string",
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
