import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurableJobStore } from "@repo/core/adapters/cloudflare/user-data/jobs";
import type { ConflictError } from "@repo/core/application/errors";
import type { RpcResult } from "@repo/core/application/identity/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalUserDataDurableObject as UserDataDurableObject } from "../../testing/LocalUserDataDurableObject";
import { shouldMoveAlarm } from "../UserDataDurableObject";

type TestEnv = {
  USER_DATA: DurableObjectNamespace<UserDataDurableObject>;
};

const bindings = env as unknown as TestEnv;

afterEach(() => reset());

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

async function initialized(name: string) {
  const stub = bindings.USER_DATA.getByName(`jobs-${name}`);
  value(
    await stub.initialize({
      operationId: "init",
      userId: `jobs-${name}`,
      now: 1,
    }),
  );
  return stub;
}

describe("User Data persistent jobs", () => {
  it("detects ID/provider payload conflicts and accepts exact replays", async () => {
    const stub = await initialized("digest");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new DurableJobStore(state.storage);
      const input = {
        id: "job-1",
        kind: "purge-trash",
        payload: { id: "memo-1", kind: "memo" },
        nextRunAt: 10,
        providerIdempotencyKey: "purge:memo-1",
        now: 1,
      };
      expect(store.enqueue(input)).toBe(10);
      expect(store.enqueue(input)).toBe(10);
      expect(() =>
        store.enqueue({
          ...input,
          payload: { id: "memo-2", kind: "memo" },
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "JOB_IDEMPOTENCY_CONFLICT",
        }) as ConflictError,
      );
      expect(() =>
        store.enqueue({
          ...input,
          id: "job-2",
          payload: { id: "memo-2", kind: "memo" },
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "JOB_IDEMPOTENCY_CONFLICT",
        }) as ConflictError,
      );
    });
  });

  it("reclaims expired leases and enforces owner CAS, poison, and batch bounds", async () => {
    const stub = await initialized("lease");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new DurableJobStore(state.storage);
      for (let index = 0; index < 30; index += 1) {
        store.enqueue({
          id: `job-${index.toString().padStart(2, "0")}`,
          kind: "purge-trash",
          payload: { id: `memo-${index}`, kind: "memo" },
          nextRunAt: 1,
          providerIdempotencyKey: `provider-${index}`,
          now: 1,
        });
      }
      const firstBatch = store.claim({
        now: 2,
        leaseMs: 1_000,
        ownerToken: "owner-a",
        limit: 50,
      });
      expect(firstBatch).toHaveLength(25);
      expect(store.complete(firstBatch[0].id, "wrong-owner", 3)).toBe(false);
      const reclaimed = store.claim({
        now: 1_003,
        leaseMs: 1_000,
        ownerToken: "owner-b",
        limit: 1,
      });
      expect(reclaimed[0]).toMatchObject({
        id: firstBatch[0].id,
        ownerToken: "owner-b",
        attempt: 2,
      });
      expect(
        store.retryOrPoison({
          id: reclaimed[0].id,
          ownerToken: "owner-a",
          now: 1_004,
          maxAttempts: 2,
          retryAt: 2_000,
          reason: "stale owner",
        }),
      ).not.toBeNull();
      store.retryOrPoison({
        id: reclaimed[0].id,
        ownerToken: "owner-b",
        now: 1_004,
        maxAttempts: 2,
        retryAt: 2_000,
        reason: "permanent failure",
      });
      expect(
        state.storage.sql
          .exec<{ status: string; terminal_reason: string }>(
            "SELECT status, terminal_reason FROM jobs WHERE id = ?",
            reclaimed[0].id,
          )
          .one(),
      ).toEqual({
        status: "poison",
        terminal_reason: "permanent failure",
      });
      const plan = state.storage.sql
        .exec<{ detail: string }>(
          `EXPLAIN QUERY PLAN
           SELECT id FROM jobs
           WHERE status = 'leased' AND lease_until <= 1000`,
        )
        .toArray()
        .map((row) => row.detail)
        .join(" ");
      expect(plan).toContain("jobs_reclaim_idx");
    });
  });

  it("poisons a corrupt stored payload without starving later due jobs", async () => {
    const stub = await initialized("corrupt-payload");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new DurableJobStore(state.storage);
      for (const id of ["a-corrupt", "b-valid"]) {
        store.enqueue({
          id,
          kind: "purge-trash",
          payload: { id, kind: "memo", trashedAt: 1 },
          nextRunAt: 1,
          providerIdempotencyKey: id,
          now: 1,
        });
      }
      state.storage.sql.exec(
        "UPDATE jobs SET payload_json = '{' WHERE id = 'a-corrupt'",
      );
      const claimed = store.claim({
        now: 2,
        leaseMs: 60_000,
        ownerToken: "owner",
        limit: 25,
      });
      expect(claimed.map(({ id }) => id)).toEqual(["b-valid"]);
      expect(store.complete("b-valid", "owner", 3)).toBe(true);
      expect(
        state.storage.sql
          .exec<{ id: string; status: string; terminal_reason: string | null }>(
            `SELECT id, status, terminal_reason FROM jobs
             ORDER BY id`,
          )
          .toArray(),
      ).toEqual([
        {
          id: "a-corrupt",
          status: "poison",
          terminal_reason: "STORED_JOB_PAYLOAD_INVALID",
        },
        { id: "b-valid", status: "completed", terminal_reason: null },
      ]);
    });
  });

  it("prunes terminal rows according to bounded retention", async () => {
    const stub = await initialized("retention");
    await runInDurableObject(stub, (_instance, state) => {
      const store = new DurableJobStore(state.storage);
      const now = 40 * 86_400_000;
      state.storage.sql.exec(
        `INSERT INTO jobs(
           id, kind, payload_json, payload_digest, status, attempt,
           next_run_at, provider_idempotency_key, terminal_at,
           created_at, updated_at
         ) VALUES
           ('completed-old', 'x', '{}', 'a', 'completed', 1, 1, 'p1', ?, 1, 1),
           ('poison-old', 'x', '{}', 'b', 'poison', 5, 1, 'p2', ?, 1, 1),
           ('completed-new', 'x', '{}', 'c', 'completed', 1, 1, 'p3', ?, 1, 1)`,
        now - 8 * 86_400_000,
        now - 31 * 86_400_000,
        now - 1,
      );
      expect(store.pruneTerminal(now)).toBe(2);
      expect(
        state.storage.sql
          .exec<{ id: string }>("SELECT id FROM jobs ORDER BY id")
          .toArray(),
      ).toEqual([{ id: "completed-new" }]);
    });
  });

  it("automatically schedules final terminal cleanup", async () => {
    const stub = await initialized("terminal-alarm");
    const now = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO jobs(
           id, kind, payload_json, payload_digest, status, attempt,
           next_run_at, provider_idempotency_key, terminal_at,
           created_at, updated_at
         ) VALUES ('completed-old', 'x', '{}', 'sha256:a', 'completed', 1,
                   1, 'terminal-provider', ?, 1, 1)`,
        now - 8 * 86_400_000,
      );
    });
    value(await stub.getProfile());
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM jobs WHERE id = 'completed-old'",
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("does not postpone an overdue or imminent alarm from a normal RPC", async () => {
    const stub = await initialized("overdue");
    const now = Date.now();
    await runInDurableObject(stub, async (instance, state) => {
      new DurableJobStore(state.storage).enqueue({
        id: "future",
        kind: "purge-trash",
        payload: { id: "memo", kind: "memo", trashedAt: now },
        nextRunAt: now + 60_000,
        providerIdempotencyKey: "future",
        now,
      });
      const imminent = Date.now() + 5_000;
      await state.storage.setAlarm(imminent);
      value(await (instance as unknown as UserDataDurableObject).getProfile());
      expect(await state.storage.getAlarm()).toBe(imminent);
    });
    expect(shouldMoveAlarm(now - 1, now + 60_000)).toBe(false);
  });

  it("retries the real alarm handler and poisons after the attempt limit", async () => {
    const stub = await initialized("alarm-retry");
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.now();
      new DurableJobStore(state.storage).enqueue({
        id: "unsupported",
        kind: "unsupported",
        payload: {},
        nextRunAt: now - 1,
        providerIdempotencyKey: "unsupported",
        now,
      });
      await state.storage.setAlarm(now + 1_000);
    });
    await evictDurableObject(stub);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await runInDurableObject(stub, async (_instance, state) => {
        const row = state.storage.sql
          .exec<{ status: string; attempt: number }>(
            "SELECT status, attempt FROM jobs WHERE id = 'unsupported'",
          )
          .one();
        expect(row.attempt).toBe(attempt);
        expect(row.status).toBe(attempt === 5 ? "poison" : "pending");
        if (attempt < 5) {
          const due = Date.now() - 1;
          state.storage.sql.exec(
            "UPDATE jobs SET next_run_at = ? WHERE id = 'unsupported'",
            due,
          );
        }
      });
    }
  });

  it("recovers a failed alarm schedule from the next input gate", async () => {
    const stub = await initialized("alarm-schedule-failure");
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.now();
      new DurableJobStore(state.storage).enqueue({
        id: "unsupported",
        kind: "unsupported",
        payload: {},
        nextRunAt: now - 1,
        providerIdempotencyKey: "unsupported",
        now,
      });
      await state.storage.setAlarm(now + 1_000);
    });
    await stub.failNextAlarmSchedules(1);
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      "TEST_SET_ALARM_FAILURE",
    );
    value(await stub.getProfile());
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(
        state.storage.sql
          .exec<{ status: string; attempt: number }>(
            "SELECT status, attempt FROM jobs WHERE id = 'unsupported'",
          )
          .one(),
      ).toEqual({ status: "pending", attempt: 1 });
    });
  });

  it("recomputes existing trash and jobs when retention changes", async () => {
    const stub = await initialized("dynamic-retention");
    const trashedAt = Date.now();
    value(
      await stub.commit({
        version: 1,
        operationId: "create",
        type: "create-memo",
        memo: { id: "memo", body: "memo", timestamp: trashedAt - 1 },
      }),
    );
    value(
      await stub.commit({
        version: 1,
        operationId: "trash",
        type: "trash-memo",
        memoId: "memo",
        trashedAt,
        expectedVersion: 0,
      }),
    );
    expect(
      value(
        await stub.updateTrashRetention({
          version: 1,
          operationId: "retention-short",
          retentionDays: 1,
          updatedAt: trashedAt + 1,
        }),
      ).trashRetentionDays,
    ).toBe(1);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ purge_after: number }>(
            "SELECT purge_after FROM trash WHERE content_id = 'memo'",
          )
          .one().purge_after,
      ).toBe(trashedAt + 86_400_000);
      expect(
        state.storage.sql
          .exec<{ next_run_at: number }>(
            "SELECT next_run_at FROM jobs WHERE status = 'pending'",
          )
          .one().next_run_at,
      ).toBe(trashedAt + 86_400_000);
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(trashedAt + 86_400_000);
    });
    value(
      await stub.updateTrashRetention({
        version: 1,
        operationId: "retention-long",
        retentionDays: 60,
        updatedAt: trashedAt + 2,
      }),
    );
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ purge_after: number }>(
            "SELECT purge_after FROM trash WHERE content_id = 'memo'",
          )
          .one().purge_after,
      ).toBe(trashedAt + 60 * 86_400_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(trashedAt + 60 * 86_400_000);
    });
  });

  it("updates leased retention jobs and defers them without poisoning", async () => {
    const stub = await initialized("leased-retention");
    const trashedAt = Date.now() - 31 * 86_400_000;
    value(
      await stub.commit({
        version: 1,
        operationId: "create",
        type: "create-memo",
        memo: { id: "memo", body: "leased", timestamp: trashedAt - 1 },
      }),
    );
    value(
      await stub.commit({
        version: 1,
        operationId: "trash",
        type: "trash-memo",
        memoId: "memo",
        trashedAt,
        expectedVersion: 0,
      }),
    );
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        new DurableJobStore(state.storage).claim({
          now: Date.now(),
          leaseMs: 60_000,
          ownerToken: "retention-owner",
          limit: 1,
        }),
      ).toHaveLength(1);
    });
    value(
      await stub.updateTrashRetention({
        version: 1,
        operationId: "extend",
        retentionDays: 60,
        updatedAt: Date.now(),
      }),
    );
    await runInDurableObject(stub, (_instance, state) => {
      const job = state.storage.sql
        .exec<{ status: string; next_run_at: number }>(
          "SELECT status, next_run_at FROM jobs WHERE kind = 'purge-trash'",
        )
        .one();
      expect(job).toEqual({
        status: "leased",
        next_run_at: trashedAt + 60 * 86_400_000,
      });
      state.storage.sql.exec(
        "UPDATE jobs SET lease_until = ? WHERE kind = 'purge-trash'",
        Date.now() - 1,
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ status: string; attempt: number }>(
            "SELECT status, attempt FROM jobs WHERE kind = 'purge-trash'",
          )
          .one(),
      ).toEqual({ status: "pending", attempt: 1 });
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM content WHERE id = 'memo'",
          )
          .one().count,
      ).toBe(1);
    });
  });

  it("purges a maximum-size topic in bounded alarm chunks", async () => {
    const stub = await initialized("topic-chunks");
    const expiredAt = Date.now() - 31 * 86_400_000;
    value(
      await stub.commit({
        version: 1,
        operationId: "topic",
        type: "create-topic",
        topic: { id: "topic", name: "Chunked", timestamp: expiredAt - 2 },
      }),
    );
    for (let index = 0; index < 100; index += 1) {
      value(
        await stub.commit({
          version: 1,
          operationId: `document-${index}`,
          type: "create-document",
          document: {
            id: `document-${index.toString().padStart(3, "0")}`,
            title: "Chunk",
            body: "bounded purge",
            topicId: "topic",
            sourceMemoIds: [],
            timestamp: expiredAt - 1,
          },
        }),
      );
    }
    value(
      await stub.commit({
        version: 1,
        operationId: "independent-document",
        type: "create-document",
        document: {
          id: "independent-document",
          title: "Independent",
          body: "restore after alarm purge",
          topicId: "topic",
          sourceMemoIds: [],
          timestamp: expiredAt - 1,
        },
      }),
    );
    value(
      await stub.commit({
        version: 1,
        operationId: "trash-independent-document",
        type: "trash-document",
        documentId: "independent-document",
        trashedAt: Date.now(),
        expectedVersion: 0,
      }),
    );
    value(
      await stub.commit({
        version: 1,
        operationId: "trash-topic",
        type: "trash-topic",
        topicId: "topic",
        trashedAt: expiredAt,
        expectedVersion: 0,
      }),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM content
             WHERE trashed_with_topic_id = 'topic'`,
          )
          .one().count,
      ).toBe(50);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM topics WHERE id = 'topic'",
          )
          .one().count,
      ).toBe(0);
    });
    value(
      await stub.commit({
        version: 1,
        operationId: "destination-topic",
        type: "create-topic",
        topic: {
          id: "destination-topic",
          name: "Destination",
          timestamp: Date.now(),
        },
      }),
    );
    value(
      await stub.commit({
        version: 1,
        operationId: "restore-independent-document",
        type: "restore-document",
        documentId: "independent-document",
        destinationTopicId: "destination-topic",
        restoredAt: Date.now(),
        expectedVersion: 1,
      }),
    );
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ topic_id: string; trashed_at: number | null }>(
            `SELECT topic_id, trashed_at FROM content
             WHERE id = 'independent-document'`,
          )
          .one(),
      ).toEqual({ topic_id: "destination-topic", trashed_at: null });
    });
  });

  it("only moves an existing alarm earlier", async () => {
    const stub = await initialized("alarm");
    const now = Date.now();
    for (const [id, trashedAt] of [
      ["later", now + 10_000],
      ["earlier", now],
    ] as const) {
      value(
        await stub.commit({
          version: 1,
          operationId: `create-${id}`,
          type: "create-memo",
          memo: { id, body: id, timestamp: now - 1 },
        }),
      );
      value(
        await stub.commit({
          version: 1,
          operationId: `trash-${id}`,
          type: "trash-memo",
          memoId: id,
          trashedAt,
          expectedVersion: 0,
        }),
      );
    }
    await runInDurableObject(stub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBe(now + 30 * 86_400_000);
    });
  });
});
