import type { SqlStorage } from "@cloudflare/workers-types";
import { isConflictError } from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import { inUserData } from "../../__tests__/doHarness";
import { runMigrationGate } from "../../schema/gate";
import { USER_DATA_CODE_VERSION, USER_DATA_STEPS } from "../../schema/userData";
import {
  claimJob,
  completeJob,
  earliestNextRunAt,
  enqueueJob,
  failJob,
  type JobRow,
  listRunnable,
  poisonJob,
  pruneCompleted,
  releaseJob,
} from "../table";

let seq = 0;
function fresh<T>(fn: (sql: SqlStorage) => T) {
  seq += 1;
  const name = `jobs-${seq}`;
  return inUserData(name, ({ ctx, sql }) => {
    runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, name);
    return fn(sql);
  });
}

function rows(sql: SqlStorage): JobRow[] {
  return sql
    .exec<JobRow>("SELECT * FROM jobs ORDER BY operation_key")
    .toArray();
}

describe("enqueueJob convergence", () => {
  it("collapses duplicate enqueues onto a single row", async () => {
    const result = await fresh((sql) => {
      for (let i = 0; i < 3; i += 1) {
        enqueueJob(sql, 1000, {
          kind: "purge-trash",
          operationKey: "purge-trash",
          payload: { v: 1 },
          nextRunAt: 5000,
        });
      }
      return rows(sql);
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("pending");
    expect(result[0]?.attempt).toBe(0);
  });

  it("moves next_run_at earlier but never later", async () => {
    const result = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "purge-trash",
        operationKey: "purge-trash",
        payload: { v: 1 },
        nextRunAt: 5000,
      });
      enqueueJob(sql, 1000, {
        kind: "purge-trash",
        operationKey: "purge-trash",
        payload: { v: 1 },
        nextRunAt: 9000,
      });
      const afterLater = rows(sql)[0]?.next_run_at;
      enqueueJob(sql, 1000, {
        kind: "purge-trash",
        operationKey: "purge-trash",
        payload: { v: 1 },
        nextRunAt: 2000,
      });
      return { afterLater, afterEarlier: rows(sql)[0]?.next_run_at };
    });
    expect(result.afterLater).toBe(5000);
    expect(result.afterEarlier).toBe(2000);
  });

  it("does not reschedule a running row", async () => {
    const result = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "purge-trash",
        operationKey: "purge-trash",
        payload: { v: 1 },
        nextRunAt: 5000,
      });
      claimJob(sql, "purge-trash", 6000, "owner-1", 60_000);
      enqueueJob(sql, 6000, {
        kind: "purge-trash",
        operationKey: "purge-trash",
        payload: { v: 1 },
        nextRunAt: 1000,
      });
      return rows(sql)[0];
    });
    expect(result?.status).toBe("running");
    expect(result?.next_run_at).toBe(5000);
  });

  it("rejects a different payload only while the row is runnable", async () => {
    const result = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "send-mail",
        operationKey: "send-mail:1",
        payload: { to: "a" },
        nextRunAt: 5000,
      });
      let conflicted = false;
      try {
        enqueueJob(sql, 1000, {
          kind: "send-mail",
          operationKey: "send-mail:1",
          payload: { to: "b" },
          nextRunAt: 5000,
        });
      } catch (error) {
        conflicted = isConflictError(error);
      }
      // …but once it is terminal, rules (2) / (3) take precedence and the
      // differing payload is simply the next run's input.
      claimJob(sql, "send-mail:1", 6000, "owner-1", 60_000);
      poisonJob(sql, "send-mail:1", "owner-1", 6000, "TEST");
      enqueueJob(sql, 7000, {
        kind: "send-mail",
        operationKey: "send-mail:1",
        payload: { to: "b" },
        nextRunAt: 8000,
      });
      return { conflicted, row: rows(sql)[0] };
    });
    expect(result.conflicted).toBe(true);
    expect(result.row?.status).toBe("pending");
    expect(result.row?.payload).toBe(JSON.stringify({ to: "b" }));
  });

  it("revives a done row for a re-arming kind", async () => {
    const result = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "purge-trash",
        operationKey: "purge-trash",
        payload: { v: 1 },
        nextRunAt: 5000,
      });
      claimJob(sql, "purge-trash", 6000, "owner-1", 60_000);
      completeJob(sql, "purge-trash", "owner-1", 6000, null);
      const done = rows(sql)[0]?.status;
      enqueueJob(sql, 7000, {
        kind: "purge-trash",
        operationKey: "purge-trash",
        payload: { v: 1 },
        nextRunAt: 9000,
      });
      return { done, after: rows(sql)[0] };
    });
    expect(result.done).toBe("done");
    expect(result.after?.status).toBe("pending");
    expect(result.after?.next_run_at).toBe(9000);
    expect(result.after?.completed_at).toBeNull();
  });

  it("leaves a done row alone for a one-shot kind", async () => {
    const result = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "send-mail",
        operationKey: "send-mail:1",
        payload: { v: 1 },
        nextRunAt: 5000,
      });
      claimJob(sql, "send-mail:1", 6000, "owner-1", 60_000);
      completeJob(sql, "send-mail:1", "owner-1", 6000, null);
      enqueueJob(sql, 7000, {
        kind: "send-mail",
        operationKey: "send-mail:1",
        payload: { v: 1 },
        nextRunAt: 9000,
      });
      return rows(sql)[0];
    });
    expect(result?.status).toBe("done");
    expect(result?.next_run_at).toBeNull();
  });

  it("revives a poison row for any kind and keeps terminal_reason", async () => {
    const result = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "send-mail",
        operationKey: "send-mail:1",
        payload: { v: 1 },
        nextRunAt: 5000,
      });
      claimJob(sql, "send-mail:1", 6000, "owner-1", 60_000);
      poisonJob(
        sql,
        "send-mail:1",
        "owner-1",
        6000,
        "SystemError:DATABASE_ERROR",
      );
      enqueueJob(sql, 7000, {
        kind: "send-mail",
        operationKey: "send-mail:1",
        payload: { v: 1 },
        nextRunAt: 9000,
      });
      return { all: rows(sql), row: rows(sql)[0] };
    });
    expect(result.all).toHaveLength(1);
    expect(result.row?.status).toBe("pending");
    expect(result.row?.attempt).toBe(0);
    expect(result.row?.terminal_reason).toBe("SystemError:DATABASE_ERROR");
  });
});

describe("claim and lease", () => {
  it("reclaims a running row whose lease expired", async () => {
    const result = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "purge-trash",
        operationKey: "purge-trash",
        payload: {},
        nextRunAt: 5000,
      });
      const first = claimJob(sql, "purge-trash", 6000, "owner-1", 1_000);
      const whileHeld = claimJob(sql, "purge-trash", 6100, "owner-2", 1_000);
      // The DO reset: the lease expires and another owner takes over.
      const afterExpiry = claimJob(sql, "purge-trash", 9000, "owner-2", 1_000);
      return {
        first,
        whileHeld,
        afterExpiry,
        owner: rows(sql)[0]?.owner_token,
      };
    });
    expect(result).toEqual({
      first: true,
      whileHeld: false,
      afterExpiry: true,
      owner: "owner-2",
    });
  });

  it("never reclaims a terminal row that still carries a stale lease", async () => {
    const result = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "send-mail",
        operationKey: "k",
        payload: {},
        nextRunAt: 5000,
      });
      claimJob(sql, "k", 6000, "owner-1", 1_000);
      // Write a terminal state that deliberately leaves a stale lease behind,
      // which is exactly the shape a `status='running'`-less claim predicate
      // would wrongly pick up.
      sql.exec(
        "UPDATE jobs SET status='done', completed_at=6000, lease_until=6001, owner_token='owner-1', next_run_at=NULL WHERE operation_key='k'",
      );
      return claimJob(sql, "k", 99_000, "owner-2", 1_000);
    });
    expect(result).toBe(false);
  });

  it("only completes for the owner that holds the lease", async () => {
    const result = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "send-mail",
        operationKey: "k",
        payload: {},
        nextRunAt: 5000,
      });
      claimJob(sql, "k", 6000, "owner-1", 60_000);
      completeJob(sql, "k", "owner-2", 6000, null);
      return rows(sql)[0]?.status;
    });
    expect(result).toBe("running");
  });
});

describe("terminal shape", () => {
  it("clears lease, owner and next_run_at when completing", async () => {
    const row = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "send-mail",
        operationKey: "k",
        payload: {},
        nextRunAt: 5000,
      });
      claimJob(sql, "k", 6000, "owner-1", 60_000);
      completeJob(sql, "k", "owner-1", 6500, null);
      return rows(sql)[0];
    });
    expect(row?.status).toBe("done");
    expect(row?.completed_at).toBe(6500);
    expect(row?.lease_until).toBeNull();
    expect(row?.owner_token).toBeNull();
    expect(row?.next_run_at).toBeNull();
  });

  it("uses the same shape when poisoning", async () => {
    const row = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "send-mail",
        operationKey: "k",
        payload: {},
        nextRunAt: 5000,
      });
      claimJob(sql, "k", 6000, "owner-1", 60_000);
      poisonJob(sql, "k", "owner-1", 6500, "SystemError:DATABASE_ERROR");
      return rows(sql)[0];
    });
    expect(row?.status).toBe("poison");
    expect(row?.completed_at).toBe(6500);
    expect(row?.lease_until).toBeNull();
    expect(row?.owner_token).toBeNull();
    expect(row?.next_run_at).toBeNull();
    expect(row?.terminal_reason).toBe("SystemError:DATABASE_ERROR");
  });

  it("re-arms without writing completed_at", async () => {
    const row = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "purge-trash",
        operationKey: "purge-trash",
        payload: {},
        nextRunAt: 5000,
      });
      claimJob(sql, "purge-trash", 6000, "owner-1", 60_000);
      completeJob(sql, "purge-trash", "owner-1", 6500, 12_000);
      return rows(sql)[0];
    });
    expect(row?.status).toBe("pending");
    expect(row?.next_run_at).toBe(12_000);
    expect(row?.completed_at).toBeNull();
  });

  it("backs off on failure and releases the lease", async () => {
    const row = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "send-mail",
        operationKey: "k",
        payload: {},
        nextRunAt: 5000,
      });
      claimJob(sql, "k", 6000, "owner-1", 60_000);
      failJob(sql, "k", "owner-1", 6000, 1, 8000);
      return rows(sql)[0];
    });
    expect(row?.status).toBe("pending");
    expect(row?.attempt).toBe(1);
    expect(row?.next_run_at).toBe(8000);
    expect(row?.owner_token).toBeNull();
  });

  it("releases a yielded row back to pending at the same time", async () => {
    const row = await fresh((sql) => {
      enqueueJob(sql, 1000, {
        kind: "purge-trash",
        operationKey: "purge-trash",
        payload: {},
        nextRunAt: 5000,
      });
      claimJob(sql, "purge-trash", 6000, "owner-1", 60_000);
      releaseJob(sql, "purge-trash", "owner-1");
      return rows(sql)[0];
    });
    expect(row?.status).toBe("pending");
    expect(row?.next_run_at).toBe(5000);
    expect(row?.owner_token).toBeNull();
  });
});

describe("scheduling reads", () => {
  it("reports the earliest runnable next_run_at, ignoring terminal rows", async () => {
    const result = await fresh((sql) => {
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey: "a",
        payload: {},
        nextRunAt: 9000,
      });
      enqueueJob(sql, 0, {
        kind: "send-mail",
        operationKey: "b",
        payload: {},
        nextRunAt: 3000,
      });
      const before = earliestNextRunAt(sql);
      claimJob(sql, "b", 3000, "owner-1", 60_000);
      completeJob(sql, "b", "owner-1", 3000, null);
      return { before, after: earliestNextRunAt(sql) };
    });
    expect(result).toEqual({ before: 3000, after: 9000 });
  });

  it("returns null when nothing is runnable", async () => {
    const result = await fresh((sql) => earliestNextRunAt(sql));
    expect(result).toBeNull();
  });

  it("excludes the operation keys it is told to skip", async () => {
    const result = await fresh((sql) => {
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey: "a",
        payload: {},
        nextRunAt: 1000,
      });
      enqueueJob(sql, 0, {
        kind: "send-mail",
        operationKey: "b",
        payload: {},
        nextRunAt: 2000,
      });
      return {
        all: listRunnable(sql, 5000, 10, []).map((r) => r.operation_key),
        skipped: listRunnable(sql, 5000, 10, ["a"]).map((r) => r.operation_key),
        notYetDue: listRunnable(sql, 1500, 10, []).map((r) => r.operation_key),
      };
    });
    expect(result.all).toEqual(["a", "b"]);
    expect(result.skipped).toEqual(["b"]);
    expect(result.notYetDue).toEqual(["a"]);
  });
});

describe("prune", () => {
  it("deletes terminal rows past their own retention, bounded", async () => {
    const result = await fresh((sql) => {
      const seed = (key: string, status: string, completedAt: number) =>
        sql.exec(
          "INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, provider_idempotency_key, terminal_reason, completed_at) VALUES (?, 'send-mail', '{}', 'd', 0, NULL, ?, NULL, NULL, NULL, NULL, ?)",
          key,
          status,
          completedAt,
        );
      seed("old-done", "done", 0);
      seed("new-done", "done", 1_000_000);
      seed("old-poison", "poison", 0);
      seed("new-poison", "poison", 1_000_000);
      enqueueJob(sql, 0, {
        kind: "send-mail",
        operationKey: "live",
        payload: {},
        nextRunAt: 1_000_000,
      });
      const deleted = pruneCompleted(sql, 1_000_100, 100, {
        done: 1_000,
        poison: 10_000,
        sendMail: 1_000,
      });
      return { deleted, left: rows(sql).map((r) => r.operation_key) };
    });
    expect(result.deleted).toBe(2);
    expect(result.left.sort()).toEqual(["live", "new-done", "new-poison"]);
  });

  it("honours the row limit", async () => {
    const deleted = await fresh((sql) => {
      for (let i = 0; i < 5; i += 1) {
        sql.exec(
          "INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, provider_idempotency_key, terminal_reason, completed_at) VALUES (?, 'send-mail', '{}', 'd', 0, NULL, 'done', NULL, NULL, NULL, NULL, 0)",
          `k${i}`,
        );
      }
      return pruneCompleted(sql, 1_000_000, 2, {
        done: 1_000,
        poison: 1_000,
        sendMail: 1_000,
      });
    });
    expect(deleted).toBe(2);
  });

  it("retires a send-mail row on its own window, not on the shared one", async () => {
    const result = await fresh((sql) => {
      const seed = (key: string, kind: string, completedAt: number) =>
        sql.exec(
          "INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, provider_idempotency_key, terminal_reason, completed_at) VALUES (?, ?, '{}', 'd', 0, NULL, 'done', NULL, NULL, NULL, NULL, ?)",
          key,
          kind,
          completedAt,
        );
      // Same age, different kinds: only the shorter retention takes its row.
      seed("mail", "send-mail", 0);
      seed("purge", "purge-trash", 0);
      const deleted = pruneCompleted(sql, 20_000, 100, {
        done: 100_000,
        poison: 100_000,
        sendMail: 10_000,
      });
      return { deleted, left: rows(sql).map((r) => r.operation_key) };
    });
    // The `send-mail` retention *is* the request window: a row that outlived it
    // would keep refusing legitimate re-requests, and the whole reason it is
    // kind-scoped rather than outcome-scoped is that a lifetime varying with
    // the result would be an enumeration oracle.
    expect(result.deleted).toBe(1);
    expect(result.left).toEqual(["purge"]);
  });
});
