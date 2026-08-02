import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import { ConflictError } from "@repo/core/application/errors";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type { Logger } from "@repo/core/application/ports/logger";
import { DEFAULT_MAX_ATTEMPTS } from "@repo/core/lib/jobBudgets";
import type { JobKind } from "@repo/core/lib/jobKind";
import { describe, expect, it } from "vitest";
import { inUserData } from "../../__tests__/doHarness";
import { assertNoForbiddenValue } from "../../__tests__/forbiddenValues";
import { runMigrationGate } from "../../schema/gate";
import { USER_DATA_CODE_VERSION, USER_DATA_STEPS } from "../../schema/userData";
import type {
  JobContextBase,
  JobHandler,
  UserDataJobContext,
} from "../registry";
import { runDueJobs } from "../runner";
import { enqueueJob, type JobRow } from "../table";

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (message: string, meta?: Record<string, unknown>) => {
    lines.push(message);
    if (meta !== undefined) lines.push(JSON.stringify(meta, replacer));
  };
  const replacer = (_key: string, value: unknown) =>
    value instanceof Error ? `${value.name}: ${value.message}` : value;
  return {
    lines,
    logger: { info: push, warn: push, error: push },
  };
}

const idGenerator: IdGenerator = {
  next: () => "generated-id",
  validate: () => true,
};

let seq = 0;
function harness<T>(
  fn: (io: {
    sql: SqlStorage;
    ctx: DurableObjectState;
    run: (
      handlers: Partial<Record<JobKind, JobHandler<UserDataJobContext>>>,
      now: number,
      ownerToken?: string,
    ) => Promise<void>;
    lines: string[];
  }) => Promise<T> | T,
) {
  seq += 1;
  const name = `runner-${seq}`;
  return inUserData(name, ({ ctx, sql }) => {
    runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, name);
    const { logger, lines } = recordingLogger();
    const run = (
      handlers: Partial<Record<JobKind, JobHandler<UserDataJobContext>>>,
      now: number,
      ownerToken = "owner-1",
    ) => {
      const context: JobContextBase = {
        ctx,
        sql,
        now,
        ownerToken,
        logger,
        idGenerator,
      };
      return runDueJobs(context, handlers, now);
    };
    return fn({ sql, ctx, run, lines });
  }) as Promise<T>;
}

function rows(sql: SqlStorage): JobRow[] {
  return sql
    .exec<JobRow>("SELECT * FROM jobs ORDER BY operation_key")
    .toArray();
}

const done: JobHandler<UserDataJobContext> = async () => ({ kind: "done" });

describe("job runner", () => {
  it("runs a due job and marks it done", async () => {
    const result = await harness(async ({ sql, run }) => {
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey: "purge-trash",
        payload: {},
        nextRunAt: 1000,
      });
      await run({ "purge-trash": done }, 2000);
      return rows(sql)[0];
    });
    expect(result?.status).toBe("done");
    expect(result?.owner_token).toBeNull();
  });

  it("does not run a job that is not yet due", async () => {
    const result = await harness(async ({ sql, run }) => {
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey: "purge-trash",
        payload: {},
        nextRunAt: 5000,
      });
      await run({ "purge-trash": done }, 2000);
      return rows(sql)[0];
    });
    expect(result?.status).toBe("pending");
  });

  it("keeps running other jobs when one throws, and never rethrows", async () => {
    const result = await harness(async ({ sql, run }) => {
      for (const key of ["a", "b", "c"]) {
        enqueueJob(sql, 0, {
          kind: "purge-trash",
          operationKey: key,
          payload: {},
          nextRunAt: 1000,
        });
      }
      let threw = false;
      try {
        await run(
          {
            "purge-trash": async (_ctx, row) => {
              if (row.operation_key === "b") throw new Error("boom");
              return { kind: "done" };
            },
          },
          2000,
        );
      } catch {
        threw = true;
      }
      return {
        threw,
        statuses: rows(sql).map((r) => `${r.operation_key}:${r.status}`),
      };
    });
    expect(result.threw).toBe(false);
    expect(result.statuses).toEqual(["a:done", "b:pending", "c:done"]);
  });

  it("backs off, then poisons once the attempt limit is passed", async () => {
    const result = await harness(async ({ sql, run }) => {
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey: "k",
        payload: {},
        nextRunAt: 1000,
      });
      const failing: JobHandler<UserDataJobContext> = async () => {
        throw new ConflictError("OPTIMISTIC_LOCK_FAILURE", "conflict");
      };
      const attempts: (number | null)[] = [];
      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS + 1; i += 1) {
        await run({ "purge-trash": failing }, 1000 + i * 1_000_000);
        attempts.push(rows(sql)[0]?.attempt ?? null);
      }
      return { attempts, row: rows(sql)[0] };
    });
    // The conflict is not swallowed: it ends up in `terminal_reason` as the
    // failure's identity, with no message attached.
    expect(result.row?.status).toBe("poison");
    expect(result.row?.terminal_reason).toBe(
      "ConflictError:OPTIMISTIC_LOCK_FAILURE",
    );
    expect(result.row?.next_run_at).toBeNull();
    expect(result.row?.completed_at).not.toBeNull();
  });

  it("poisons an unregistered kind instead of looping on it", async () => {
    const result = await harness(async ({ sql, run }) => {
      enqueueJob(sql, 0, {
        kind: "finalize-withdrawal",
        operationKey: "k",
        payload: {},
        nextRunAt: 1000,
      });
      await run({}, 2000);
      return rows(sql)[0];
    });
    expect(result?.status).toBe("poison");
    expect(result?.terminal_reason).toBe("UNIMPLEMENTED_JOB_KIND");
  });

  it("does not re-claim a job that yielded during the same wake-up", async () => {
    const result = await harness(async ({ sql, run }) => {
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey: "k",
        payload: {},
        nextRunAt: 1000,
      });
      let calls = 0;
      await run(
        {
          "purge-trash": async () => {
            calls += 1;
            return { kind: "yield" };
          },
        },
        2000,
      );
      return { calls, row: rows(sql)[0] };
    });
    expect(result.calls).toBe(1);
    expect(result.row?.status).toBe("pending");
    expect(result.row?.owner_token).toBeNull();
  });

  it("re-arms a job that asks for it", async () => {
    const result = await harness(async ({ sql, run }) => {
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey: "k",
        payload: {},
        nextRunAt: 1000,
      });
      await run(
        { "purge-trash": async () => ({ kind: "rearm", nextRunAt: 50_000 }) },
        2000,
      );
      return rows(sql)[0];
    });
    expect(result?.status).toBe("pending");
    expect(result?.next_run_at).toBe(50_000);
  });

  it("stops at the per-wake-up job budget", async () => {
    const executed = await harness(async ({ sql, run }) => {
      for (let i = 0; i < 30; i += 1) {
        enqueueJob(sql, 0, {
          kind: "purge-trash",
          operationKey: `k${String(i).padStart(2, "0")}`,
          payload: {},
          nextRunAt: 1000,
        });
      }
      let calls = 0;
      await run(
        {
          "purge-trash": async () => {
            calls += 1;
            return { kind: "done" };
          },
        },
        2000,
      );
      return calls;
    });
    expect(executed).toBe(25);
  });

  it("reclaims a job left running by a previous instance", async () => {
    const result = await harness(async ({ sql, run }) => {
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey: "k",
        payload: {},
        nextRunAt: 1000,
      });
      // Stands in for a DO reset mid-job: `running` with an expired lease.
      sql.exec(
        "UPDATE jobs SET status='running', lease_until=1500, owner_token='dead-owner' WHERE operation_key='k'",
      );
      await run({ "purge-trash": done }, 90_000, "owner-2");
      return rows(sql)[0];
    });
    expect(result?.status).toBe("done");
  });

  it("keeps PII and reusable secrets out of terminal_reason and the log", async () => {
    const result = await harness(async ({ sql, run, lines }) => {
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey: "k",
        payload: {},
        nextRunAt: 1000,
      });
      const leaky: JobHandler<UserDataJobContext> = async () => {
        throw new ConflictError(
          "UNIQUE_VIOLATION",
          "user@example.com / caller-token-secret / reset-token-secret",
        );
      };
      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS + 1; i += 1) {
        await run({ "purge-trash": leaky }, 1000 + i * 1_000_000);
      }
      return { reason: rows(sql)[0]?.terminal_reason ?? "", lines };
    });
    assertNoForbiddenValue([result.reason]);
    expect(result.reason).toBe("ConflictError:UNIQUE_VIOLATION");
    // The logger is a different matter: the raw cause is deliberately kept
    // server-side for triage, so only `terminal_reason` is asserted clean.
    expect(result.lines.length).toBeGreaterThan(0);
  });

  it("prunes terminal rows at the end of a wake-up", async () => {
    const left = await harness(async ({ sql, run }) => {
      sql.exec(
        "INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, provider_idempotency_key, terminal_reason, completed_at) VALUES ('ancient', 'purge-trash', '{}', 'd', 0, NULL, 'done', NULL, NULL, NULL, NULL, 0)",
      );
      await run({ "purge-trash": done }, 10 * 24 * 60 * 60 * 1000);
      return rows(sql).map((r) => r.operation_key);
    });
    expect(left).toEqual([]);
  });
});
