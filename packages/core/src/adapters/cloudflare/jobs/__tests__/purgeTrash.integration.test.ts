import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type { Logger } from "@repo/core/application/ports/logger";
import { describe, expect, it } from "vitest";
import { inUserData } from "../../__tests__/doHarness";
import { runMigrationGate } from "../../schema/gate";
import { USER_DATA_CODE_VERSION, USER_DATA_STEPS } from "../../schema/userData";
import { upsertSearchEntry } from "../../search/projection";
import { purgeTrash } from "../handlers/purgeTrash";
import type { UserDataJobContext } from "../registry";
import { enqueueJob, type JobRow } from "../table";

/**
 * `purge-trash` end to end inside a real Durable Object.
 *
 * The two phases and the re-arm are the whole point, so the assertions are
 * about *outcomes* — what survived, what the next wake-up is — rather than
 * about which statements were issued.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = 10 * DAY;

const idGenerator: IdGenerator = {
  next: () => "generated-id",
  validate: () => true,
};

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (message: string) => {
    lines.push(message);
  };
  return { lines, logger: { info: push, warn: push, error: push } };
}

let seq = 0;

type Io = {
  sql: SqlStorage;
  ctx: DurableObjectState;
  lines: string[];
  run: (now?: number) => Promise<{ kind: string; nextRunAt?: number }>;
};

function harness<T>(fn: (io: Io) => Promise<T> | T): Promise<T> {
  seq += 1;
  const name = `purge-${seq}`;
  return inUserData(name, ({ ctx, sql }) => {
    runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, name);
    const { logger, lines } = recordingLogger();
    const run = async (now = NOW) => {
      const context: UserDataJobContext = {
        ctx,
        sql,
        now,
        ownerToken: "owner-1",
        logger,
        idGenerator,
      };
      const row = { operation_key: "purge-trash", payload: "{}" } as JobRow;
      return purgeTrash(context, row);
    };
    return fn({ sql, ctx, lines, run });
  }) as Promise<T>;
}

function setRetention(sql: SqlStorage, days: number): void {
  sql.exec("DELETE FROM user_settings");
  sql.exec(
    "INSERT INTO user_settings (trash_retention_days, version, created_at, updated_at) VALUES (?, 1, 0, 0)",
    days,
  );
}

function addMemo(
  sql: SqlStorage,
  id: string,
  trashedAt: number | null,
  purgeAfter: number | null,
): void {
  sql.exec(
    `INSERT INTO memos (id, body, latest_revision_number, posted_at, status,
                        trashed_at, purge_after, version, updated_at)
     VALUES (?, ?, 1, 0, ?, ?, ?, 1, 0)`,
    id,
    `body of ${id}`,
    trashedAt === null ? "active" : "trashed",
    trashedAt,
    purgeAfter,
  );
  upsertSearchEntry(sql, {
    id,
    type: "memo",
    topicId: null,
    title: "",
    body: `body of ${id}`,
    timestamp: 0,
    sourceIds: [],
  });
}

function addTopic(
  sql: SqlStorage,
  id: string,
  trashedAt: number | null,
  purgeAfter: number | null,
): void {
  sql.exec(
    `INSERT INTO topics (id, name, description, status, trashed_at, purge_after,
                         was_archived, version, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 1, 0, 0)`,
    id,
    id,
    trashedAt === null ? "active" : "trashed",
    trashedAt,
    purgeAfter,
    trashedAt === null ? null : 0,
  );
}

function addDocument(
  sql: SqlStorage,
  id: string,
  topicId: string,
  trashedAt: number | null,
  purgeAfter: number | null,
  trashedWith: string | null = null,
): void {
  sql.exec(
    `INSERT INTO documents (id, topic_id, title, body, latest_revision_number,
                            status, trashed_at, purge_after, trashed_with,
                            version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1, 0, 0)`,
    id,
    topicId,
    `title of ${id}`,
    `body of ${id}`,
    trashedAt === null ? "active" : "trashed",
    trashedAt,
    purgeAfter,
    trashedWith,
  );
  upsertSearchEntry(sql, {
    id,
    type: "document",
    topicId,
    title: `title of ${id}`,
    body: `body of ${id}`,
    timestamp: 0,
    sourceIds: [],
  });
}

function ids(sql: SqlStorage, table: "memos" | "topics" | "documents") {
  return sql
    .exec<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)
    .toArray()
    .map((row) => row.id);
}

function projectedIds(sql: SqlStorage): string[] {
  return sql
    .exec<{ id: string }>("SELECT id FROM search_entries ORDER BY id")
    .toArray()
    .map((row) => row.id);
}

function purgeAfterOf(
  sql: SqlStorage,
  table: "memos" | "documents",
  id: string,
): number | null {
  return (
    sql
      .exec<{ purge_after: number | null }>(
        `SELECT purge_after FROM ${table} WHERE id = ?`,
        id,
      )
      .toArray()[0]?.purge_after ?? null
  );
}

/**
 * `purge_after` is a pure function of `(trashed_at, trashRetentionDays)`, which
 * is exactly what lets the recomputation predicate consume itself. Fixtures
 * therefore have to be *consistent*: an inconsistent one is simply a row the
 * recomputation phase repairs, and the test would then measure the repair.
 */
function purgeAt(trashedAt: number, retentionDays: number): number {
  return trashedAt + retentionDays * DAY;
}

describe("purge-trash", () => {
  it("deletes only the items whose retention has elapsed", async () => {
    const result = await harness(async ({ sql, run }) => {
      setRetention(sql, 7);
      addMemo(sql, "due", NOW - 8 * DAY, purgeAt(NOW - 8 * DAY, 7));
      addMemo(sql, "not-due", NOW - 6 * DAY, purgeAt(NOW - 6 * DAY, 7));
      addMemo(sql, "live", null, null);
      const outcome = await run();
      return { outcome, memos: ids(sql, "memos"), entries: projectedIds(sql) };
    });
    expect(result.memos).toEqual(["live", "not-due"]);
    expect(result.entries).toEqual(["live", "not-due"]);
    // Class (A): the next wake-up is the next surviving item's own expiry.
    expect(result.outcome).toEqual({
      kind: "rearm",
      nextRunAt: purgeAt(NOW - 6 * DAY, 7),
    });
  });

  it("settles to done once the trash is empty", async () => {
    const outcome = await harness(async ({ sql, run }) => {
      setRetention(sql, 7);
      addMemo(sql, "due", NOW - 8 * DAY, purgeAt(NOW - 8 * DAY, 7));
      return run();
    });
    expect(outcome).toEqual({ kind: "done" });
  });

  it("leaves the drive signal strictly in the future after a run", async () => {
    const outcome = await harness(async ({ sql, run }) => {
      setRetention(sql, 7);
      addMemo(sql, "due", NOW - 9 * DAY, purgeAt(NOW - 9 * DAY, 7));
      addMemo(sql, "not-due", NOW - 2 * DAY, purgeAt(NOW - 2 * DAY, 7));
      addTopic(sql, "t-due", NOW - 8 * DAY, purgeAt(NOW - 8 * DAY, 7));
      return run();
    });
    // This is the invariant the clamp inside the handler exists to defend: the
    // drive signal is the minimum over the *same* predicate the deletion uses,
    // so a completed wake-up can never leave it in the past. If it ever does,
    // the two queries have drifted apart and the DO would wake forever.
    expect(outcome.kind).toBe("rearm");
    expect(outcome.nextRunAt ?? 0).toBeGreaterThan(NOW);
  });

  it("drops a restored item out of the drive signal", async () => {
    const outcome = await harness(async ({ sql, run }) => {
      setRetention(sql, 7);
      addMemo(sql, "restored", NOW - DAY, purgeAt(NOW - DAY, 7));
      // Restore sets both columns back together — the invariant is
      // `status = 'trashed'` ⇔ `purge_after IS NOT NULL`.
      sql.exec(
        "UPDATE memos SET status = 'active', trashed_at = NULL, purge_after = NULL WHERE id = 'restored'",
      );
      return run();
    });
    // Reading the drive signal wider than the work predicate — for instance by
    // dropping the `status` condition — would pin it in the past here and buy
    // one alarm write per wake-up forever.
    expect(outcome).toEqual({ kind: "done" });
  });

  it("brings a shortened retention window forward for existing items", async () => {
    const result = await harness(async ({ sql, run }) => {
      setRetention(sql, 30);
      addMemo(sql, "m1", NOW - 10 * DAY, NOW - 10 * DAY + 30 * DAY);
      setRetention(sql, 7);
      const outcome = await run();
      return { outcome, memos: ids(sql, "memos") };
    });
    // 10 days in the trash under a 7-day window: recomputing makes it due, and
    // the same wake-up then deletes it.
    expect(result.memos).toEqual([]);
    expect(result.outcome).toEqual({ kind: "done" });
  });

  it("pushes a lengthened retention window back without deleting anything", async () => {
    const result = await harness(async ({ sql, run }) => {
      setRetention(sql, 7);
      addMemo(sql, "m1", NOW - 8 * DAY, NOW - 8 * DAY + 7 * DAY);
      // The item is already due under the old window. Lengthening must not let
      // this wake-up — which was scheduled for the old, earlier time — purge it.
      setRetention(sql, 30);
      const outcome = await run();
      return {
        outcome,
        memos: ids(sql, "memos"),
        purgeAfter: purgeAfterOf(sql, "memos", "m1"),
      };
    });
    expect(result.memos).toEqual(["m1"]);
    expect(result.purgeAfter).toBe(NOW - 8 * DAY + 30 * DAY);
    expect(result.outcome).toEqual({
      kind: "rearm",
      nextRunAt: NOW - 8 * DAY + 30 * DAY,
    });
  });

  it("takes a topic's documents with it when the set is purged", async () => {
    const result = await harness(async ({ sql, run }) => {
      const trashedAt = NOW - 8 * DAY;
      setRetention(sql, 7);
      addTopic(sql, "t1", trashedAt, purgeAt(trashedAt, 7));
      addDocument(sql, "d-with", "t1", trashedAt, purgeAt(trashedAt, 7), "t1");
      addDocument(sql, "d-alone", "t1", null, null);
      await run();
      return {
        topics: ids(sql, "topics"),
        documents: ids(sql, "documents"),
        entries: projectedIds(sql),
      };
    });
    expect(result.topics).toEqual([]);
    expect(result.documents).toEqual(["d-alone"]);
    expect(result.entries).toEqual(["d-alone"]);
  });

  it("rebuilds the projection of documents that cited a purged memo", async () => {
    const result = await harness(async ({ sql, run }) => {
      setRetention(sql, 7);
      addTopic(sql, "t1", null, null);
      addDocument(sql, "d1", "t1", null, null);
      addMemo(sql, "m-live", null, null);
      addMemo(sql, "m-due", NOW - 8 * DAY, purgeAt(NOW - 8 * DAY, 7));
      for (const memoId of ["m-live", "m-due"]) {
        sql.exec(
          "INSERT INTO source_links (document_id, memo_id, created_at) VALUES ('d1', ?, 0)",
          memoId,
        );
      }
      upsertSearchEntry(sql, {
        id: "d1",
        type: "document",
        topicId: "t1",
        title: "title of d1",
        body: "body of d1",
        timestamp: 0,
        sourceIds: ["m-due", "m-live"],
      });
      await run();
      const projected = sql
        .exec<{ source_ids: string }>(
          "SELECT source_ids FROM search_entries WHERE id = 'd1'",
        )
        .toArray()[0];
      return {
        memos: ids(sql, "memos"),
        sourceIds: JSON.parse(projected?.source_ids ?? "[]") as string[],
        links: sql
          .exec<{ memo_id: string }>(
            "SELECT memo_id FROM source_links WHERE document_id = 'd1'",
          )
          .toArray()
          .map((row) => row.memo_id),
      };
    });
    expect(result.memos).toEqual(["m-live"]);
    expect(result.links).toEqual(["m-live"]);
    // The dangling id is gone from the projection; nothing but this rebuild
    // would have removed it, and no constraint would have complained.
    expect(result.sourceIds).toEqual(["m-live"]);
  });

  it("is enqueued at a constant key, so repeat requests converge on one row", async () => {
    const rows = await harness(async ({ sql }) => {
      for (const at of [5000, 4000, 9000]) {
        enqueueJob(sql, 0, {
          kind: "purge-trash",
          operationKey: "purge-trash",
          payload: {},
          nextRunAt: at,
        });
      }
      return sql.exec<JobRow>("SELECT * FROM jobs").toArray();
    });
    expect(rows).toHaveLength(1);
    // Only ever earlier: a later re-enqueue is the caller asking to postpone,
    // and postponing belongs to the job's own re-arm.
    expect(rows[0]?.next_run_at).toBe(4000);
  });
});
