import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import { ConflictError } from "@repo/core/application/errors";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type { Logger } from "@repo/core/application/ports/logger";
import { backoffMs, DEFAULT_MAX_ATTEMPTS } from "@repo/core/lib/jobBudgets";
import type { JobKind } from "@repo/core/lib/jobKind";
import { describe, expect, it } from "vitest";
import { inUserData } from "../../__tests__/doHarness";
import {
  assertNoForbiddenValue,
  FORBIDDEN_VALUES,
} from "../../__tests__/forbiddenValues";
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

/** The routing hmac from the shared list — a value no log line may contain. */
const FORBIDDEN_HMAC = FORBIDDEN_VALUES[3] as string;

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
      // Each round is a wake-up an hour apart, which is past every backoff the
      // schedule can produce — so the row is due every time and the only thing
      // that ends the sequence is the attempt limit.
      const rounds: {
        now: number;
        attempt: number | null;
        nextRunAt: number | null;
        status: string | null;
      }[] = [];
      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS + 1; i += 1) {
        const now = 1000 + i * 1_000_000;
        await run({ "purge-trash": failing }, now);
        const row = rows(sql)[0];
        rounds.push({
          now,
          attempt: row?.attempt ?? null,
          nextRunAt: row?.next_run_at ?? null,
          status: row?.status ?? null,
        });
      }
      return { rounds, row: rows(sql)[0] };
    });
    // The conflict is not swallowed: it ends up in `terminal_reason` as the
    // failure's identity, with no message attached.
    expect(result.row?.status).toBe("poison");
    expect(result.row?.terminal_reason).toBe(
      "ConflictError:OPTIMISTIC_LOCK_FAILURE",
    );
    expect(result.row?.next_run_at).toBeNull();
    expect(result.row?.completed_at).not.toBeNull();

    // `attempt` counts up one per failure and stops at the limit, where the
    // row goes terminal rather than being rescheduled a ninth time.
    expect(result.rounds.map((round) => round.attempt)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 7, 7,
    ]);
    expect(result.rounds.map((round) => round.status)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "poison",
      "poison",
    ]);
    // The delay before the next wake-up is `backoffMs(attempt)` — computed
    // from *this* row's attempt count, not from a constant. Asserting the
    // schedule rather than "it grew" is what makes passing the wrong argument
    // (which would pin every round at `backoffMs(1)`) visible.
    const scheduled = result.rounds
      .filter((round) => round.nextRunAt !== null)
      .map((round) => (round.nextRunAt ?? 0) - round.now);
    expect(scheduled).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffMs(attempt)),
    );
    // …and the schedule the constants produce is strictly increasing here, so
    // the equality above is not satisfiable by a fixed delay.
    expect(scheduled).toEqual([...scheduled].sort((a, b) => a - b));
    expect(new Set(scheduled).size).toBe(scheduled.length);
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
    // The `operation_key` a `send-mail` row carries embeds the canonical
    // address's full-length HMAC, so the key itself is one of the values that
    // may not be logged — which is why the failing job below is enqueued under
    // exactly that shape rather than under a neutral one.
    const operationKey = `send-mail:email:${FORBIDDEN_HMAC}:118`;
    const result = await harness(async ({ sql, run, lines }) => {
      enqueueJob(sql, 0, {
        kind: "purge-trash",
        operationKey,
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
    // The log obeys the same rule as `terminal_reason`, and used to not: it
    // carried the whole `operation_key` and the raw exception. Both are
    // projected now — a correlation digest and the failure's identity.
    //
    // Positive control, not decoration: `assertNoForbiddenValue` over an empty
    // array passes, so the claim below is only worth anything once the runner
    // is known to have written something.
    expect(result.lines.length).toBeGreaterThan(0);
    assertNoForbiddenValue(result.lines, [operationKey]);
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
