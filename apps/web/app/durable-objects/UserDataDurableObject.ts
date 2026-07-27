import { DurableObject } from "cloudflare:workers";
import type { RpcResult } from "@repo/core/application/identity/contracts";
import type {
  SearchPage,
  SearchQuery,
  SemanticCommand,
} from "@repo/core/application/search/contracts";
import { DurableJobStore } from "@repo/core/adapters/cloudflare/user-data/jobs";
import { migrateUserData } from "@repo/core/adapters/cloudflare/user-data/schema";
import { Fts5SearchAdapter } from "@repo/core/adapters/cloudflare/user-data/searchIndex";
import { UserDataSemanticCommit } from "@repo/core/adapters/cloudflare/user-data/semanticCommit";

type StateEnv = {
  JOB_EGRESS?: Fetcher;
};

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
    this.ctx.storage.transactionSync(() => {
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
           operation_id, result_json, completed_at
         ) VALUES (?, '{"ok":true}', ?)`,
        input.operationId,
        input.now,
      );
    });
    await this.ensureAlarm();
    return { ok: true, value: this.profile() };
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

  async commit(command: SemanticCommand): Promise<RpcResult<null>> {
    const commit = new UserDataSemanticCommit(
      this.ctx.storage,
      () => this.profile().trashRetentionDays,
    );
    commit.commit(command);
    await this.ensureAlarm();
    return { ok: true, value: null };
  }

  async search(query: SearchQuery): Promise<RpcResult<SearchPage>> {
    await this.ensureAlarm();
    return {
      ok: true,
      value: this.ctx.storage.transactionSync(() =>
        new Fts5SearchAdapter(this.ctx.storage.sql).search(query),
      ),
    };
  }

  async enqueueJob(input: {
    id: string;
    kind: string;
    payload: unknown;
    nextRunAt: number;
    providerIdempotencyKey: string;
    now: number;
  }): Promise<RpcResult<null>> {
    const next = new DurableJobStore(this.ctx.storage).enqueue(input);
    if (next !== null) {
      await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1_000));
    }
    return { ok: true, value: null };
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

  async alarm(): Promise<void> {
    const now = Date.now();
    const ownerToken = crypto.randomUUID();
    const jobs = new DurableJobStore(this.ctx.storage).claim({
      now,
      leaseMs: 60_000,
      ownerToken,
      limit: 25,
    });
    for (const job of jobs) {
      try {
        if (!this.env.JOB_EGRESS) throw new Error("JOB_EGRESS_UNAVAILABLE");
        const response = await this.env.JOB_EGRESS.fetch(
          new Request("https://job-egress.invalid/jobs", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": job.providerIdempotencyKey,
            },
            body: JSON.stringify({
              id: job.id,
              kind: job.kind,
              payload: job.payload,
            }),
          }),
        );
        if (!response.ok) throw new Error(`JOB_EGRESS_${response.status}`);
        new DurableJobStore(this.ctx.storage).complete(job.id, ownerToken, now);
      } catch (error) {
        new DurableJobStore(this.ctx.storage).retryOrPoison({
          id: job.id,
          ownerToken,
          now,
          maxAttempts: 5,
          retryAt: now + Math.min(2 ** job.attempt * 1_000, 300_000),
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

  private async ensureAlarm(): Promise<void> {
    const next = new DurableJobStore(this.ctx.storage).nextRunAt();
    if (next !== null) {
      await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1_000));
    }
  }
}
