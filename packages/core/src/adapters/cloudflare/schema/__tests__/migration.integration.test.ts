import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type { Logger } from "@repo/core/application/ports/logger";
import type { JobKind } from "@repo/core/lib/jobKind";
import { describe, expect, it } from "vitest";
import { inUserData } from "../../__tests__/doHarness";
import { createMigrateBulkHandler } from "../../jobs/handlers/migrateBulk";
import { reindex } from "../../jobs/handlers/reindex";
import type { JobHandler, UserDataJobContext } from "../../jobs/registry";
import { runDueJobs } from "../../jobs/runner";
import type { JobRow } from "../../jobs/table";
import { upsertSearchEntry } from "../../search/projection";
import { all, run } from "../../sql/exec";
import type { BulkMigrationStep } from "../bulkSteps";
import { readSchemaVersion, runMigrationGate } from "../gate";
import type { MigrationStep } from "../types";
import { USER_DATA_CODE_VERSION, USER_DATA_STEPS } from "../userData";

/**
 * Lazy migration end to end: DDL, the deferred back-fill, and the fact that the
 * Durable Object keeps serving while the back-fill is still running.
 *
 * The version-2 step is **synthetic and lives only here**. Putting it in
 * `USER_DATA_STEPS` would make every real DO try to apply it; what is under
 * test is the machinery, not any particular migration.
 */

const NOW = 1_800_000_000_000;

const idGenerator: IdGenerator = {
  next: () => "generated-id",
  validate: () => true,
};

function silentLogger(): Logger {
  const noop = () => undefined;
  return { info: noop, warn: noop, error: noop };
}

/** A column addition plus the back-fill it cannot do in the same transaction. */
const V2: MigrationStep = {
  version: 2,
  statements: ["ALTER TABLE memos ADD COLUMN excerpt TEXT"],
  enqueue: [{ kind: "migrate-bulk", step: 1 }],
};

const STEPS_V2: readonly MigrationStep[] = [...USER_DATA_STEPS, V2];

/**
 * One row per chunk, deliberately ignoring the row limit: twenty-five rows then
 * exhaust the twenty-chunk budget, which is what makes the interruption path
 * reachable in a test that still runs in milliseconds.
 */
const BULK_STEP: BulkMigrationStep = {
  targetVersion: 2,
  step: 1,
  runChunk(sql, cursor) {
    const rows = all<{ id: string }>(
      sql,
      `SELECT id FROM memos
        WHERE excerpt IS NULL AND id > ?
        ORDER BY id LIMIT 1`,
      cursor,
    );
    const row = rows[0];
    if (row === undefined) return null;
    run(
      sql,
      "UPDATE memos SET excerpt = substr(body, 1, 5) WHERE id = ?",
      row.id,
    );
    return row.id;
  },
};

const HANDLERS: Partial<Record<JobKind, JobHandler<UserDataJobContext>>> = {
  "migrate-bulk": createMigrateBulkHandler([BULK_STEP]),
  reindex,
};

let seq = 0;

type Io = {
  sql: SqlStorage;
  ctx: DurableObjectState;
  gate: (steps?: readonly MigrationStep[], codeVersion?: number) => void;
  drain: () => Promise<void>;
};

function harness<T>(fn: (io: Io) => Promise<T> | T): Promise<T> {
  seq += 1;
  const name = `migration-${seq}`;
  return inUserData(name, ({ ctx, sql }) => {
    const logger = silentLogger();
    return fn({
      sql,
      ctx,
      gate: (steps = USER_DATA_STEPS, codeVersion = USER_DATA_CODE_VERSION) =>
        runMigrationGate(ctx, steps, codeVersion, name),
      drain: () =>
        runDueJobs(
          {
            ctx,
            sql,
            now: NOW,
            ownerToken: "owner-1",
            logger,
            idGenerator,
          },
          HANDLERS,
          NOW,
        ),
    });
  }) as Promise<T>;
}

function addMemos(sql: SqlStorage, count: number): void {
  for (let i = 0; i < count; i += 1) {
    sql.exec(
      `INSERT INTO memos (id, body, latest_revision_number, posted_at, status,
                          trashed_at, purge_after, version, updated_at)
       VALUES (?, ?, 1, 0, 'active', NULL, NULL, 1, 0)`,
      `memo-${String(i).padStart(3, "0")}`,
      `body number ${i}`,
    );
  }
}

function backfilled(sql: SqlStorage): number {
  return (
    sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM memos WHERE excerpt IS NOT NULL",
      )
      .toArray()[0]?.n ?? 0
  );
}

function jobs(sql: SqlStorage): JobRow[] {
  return sql
    .exec<JobRow>("SELECT * FROM jobs ORDER BY operation_key")
    .toArray();
}

function cursorRows(sql: SqlStorage) {
  return sql
    .exec<{ target_version: number; step: string; cursor: string }>(
      "SELECT target_version, step, cursor FROM migration_progress ORDER BY step",
    )
    .toArray();
}

describe("lazy migration", () => {
  it("applies the DDL and advances the version in one transaction", async () => {
    const result = await harness(({ sql, gate }) => {
      gate();
      addMemos(sql, 3);
      gate(STEPS_V2, 2);
      return {
        version: readSchemaVersion(sql),
        columns: sql
          .exec<{ name: string }>("PRAGMA table_info(memos)")
          .toArray()
          .map((row) => row.name),
      };
    });
    expect(result.version).toBe(2);
    expect(result.columns).toContain("excerpt");
  });

  it("enqueues the back-fill through the one door into jobs", async () => {
    const rows = await harness(({ sql, gate }) => {
      gate();
      gate(STEPS_V2, 2);
      return jobs(sql);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("migrate-bulk");
    expect(rows[0]?.operation_key).toBe("migrate-bulk:2:1");
    expect(JSON.parse(rows[0]?.payload ?? "null")).toEqual({
      targetVersion: 2,
      step: 1,
    });
    // Due immediately: the gate holds no clock, and a past `next_run_at` is
    // clamped by the alarm helpers rather than by the enqueue.
    expect(rows[0]?.next_run_at).toBe(0);
  });

  it("runs the back-fill from the alarm and records its progress", async () => {
    const result = await harness(async ({ sql, gate, drain }) => {
      gate();
      addMemos(sql, 5);
      gate(STEPS_V2, 2);
      await drain();
      return {
        backfilled: backfilled(sql),
        cursors: cursorRows(sql),
        status: jobs(sql)[0]?.status,
      };
    });
    expect(result.backfilled).toBe(5);
    expect(result.status).toBe("done");
    expect(result.cursors).toHaveLength(1);
    expect(result.cursors[0]?.target_version).toBe(2);
    expect(result.cursors[0]?.step).toBe("migrate-bulk:1");
  });

  it("resumes where the chunk budget ran out", async () => {
    const result = await harness(async ({ sql, gate, drain }) => {
      gate();
      addMemos(sql, 25);
      gate(STEPS_V2, 2);
      await drain();
      const afterFirst = {
        backfilled: backfilled(sql),
        status: jobs(sql)[0]?.status,
        cursor: cursorRows(sql)[0]?.cursor,
      };
      // A yielded row goes back to `pending` with its `next_run_at` intact, so
      // the next wake-up picks it up.
      await drain();
      return {
        afterFirst,
        backfilled: backfilled(sql),
        status: jobs(sql)[0]?.status,
      };
    });
    expect(result.afterFirst.backfilled).toBe(20);
    expect(result.afterFirst.status).toBe("pending");
    expect(result.afterFirst.cursor).toBe("memo-019");
    expect(result.backfilled).toBe(25);
    expect(result.status).toBe("done");
  });

  it("keeps serving reads while the back-fill is only half done", async () => {
    const rows = await harness(async ({ sql, gate, drain }) => {
      gate();
      addMemos(sql, 25);
      gate(STEPS_V2, 2);
      await drain();
      // The DDL committed, so the schema is the new one and the gate is a
      // no-op; readers see a column that is populated for some rows only. That
      // tolerance is the step author's obligation, and it is the reason the
      // DDL and the back-fill are separate steps at all.
      gate(STEPS_V2, 2);
      return sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM memos WHERE excerpt IS NULL",
        )
        .toArray()[0]?.n;
    });
    expect(rows).toBe(5);
  });

  it("refuses a back-fill this deployment no longer carries", async () => {
    const row = await harness(async ({ sql, ctx, gate }) => {
      gate();
      gate(STEPS_V2, 2);
      await runDueJobs(
        {
          ctx,
          sql,
          now: NOW,
          ownerToken: "owner-1",
          logger: silentLogger(),
          idGenerator,
        },
        { "migrate-bulk": createMigrateBulkHandler([]) },
        NOW,
      );
      return jobs(sql)[0];
    });
    // Terminal on the first attempt rather than after eight: a step the code
    // does not have cannot be finished by retrying, and a `done` row would say
    // half-migrated data is migrated.
    expect(row?.status).toBe("poison");
    expect(row?.terminal_reason).toBe("MIGRATE_BULK_STEP_UNKNOWN");
  });

  it("is fail-closed against a version newer than the code", async () => {
    const thrown = await harness(({ sql, gate }) => {
      gate();
      sql.exec("UPDATE _meta SET schema_version = 99");
      try {
        gate();
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(thrown).toContain("newer than this deployment");
  });
});

describe("reindex", () => {
  function addEntry(sql: SqlStorage, id: string, body: string): void {
    upsertSearchEntry(sql, {
      id,
      type: "memo",
      topicId: null,
      title: "東京駅の周辺",
      body,
      timestamp: 0,
      sourceIds: [],
    });
  }

  function matches(sql: SqlStorage, keyword: string): string[] {
    return sql
      .exec<{ id: string }>(
        `SELECT e.id AS id
           FROM search_fts f
           JOIN search_entries e ON e.rowid = f.rowid
          WHERE search_fts MATCH ?
          ORDER BY e.id`,
        keyword,
      )
      .toArray()
      .map((row) => row.id);
  }

  it("re-projects every entry without double-indexing it", async () => {
    const result = await harness(async ({ sql, ctx, gate }) => {
      gate();
      for (let i = 0; i < 3; i += 1)
        addEntry(sql, `e${i}`, "東京駅の構内を歩く");
      const before = matches(sql, "東京駅");
      await runDueJobs(
        {
          ctx,
          sql,
          now: NOW,
          ownerToken: "owner-1",
          logger: silentLogger(),
          idGenerator,
        },
        HANDLERS,
        NOW,
      );
      // Enqueued by hand: version 1 has no step that defers a reindex.
      sql.exec(
        `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt,
                           next_run_at, status, lease_until, owner_token,
                           provider_idempotency_key, terminal_reason, completed_at)
         VALUES ('reindex', 'reindex', '{"targetVersion":0}', 'd', 0, 0,
                 'pending', NULL, NULL, NULL, NULL, NULL)`,
      );
      await runDueJobs(
        {
          ctx,
          sql,
          now: NOW,
          ownerToken: "owner-1",
          logger: silentLogger(),
          idGenerator,
        },
        HANDLERS,
        NOW,
      );
      return { before, after: matches(sql, "東京駅"), rows: jobs(sql) };
    });
    expect(result.before).toEqual(["e0", "e1", "e2"]);
    // Each entry appears exactly once. The chunk re-projects through the same
    // `upsertSearchEntry` that subtracts the old terms first, so replaying a
    // chunk is a no-op rather than a second copy.
    expect(result.after).toEqual(["e0", "e1", "e2"]);
    expect(result.rows.find((row) => row.kind === "reindex")?.status).toBe(
      "done",
    );
  });
});
