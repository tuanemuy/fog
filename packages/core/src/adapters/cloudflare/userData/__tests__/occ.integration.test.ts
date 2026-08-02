import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import { ConflictError } from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import { inUserData } from "../../__tests__/doHarness";
import { runMigrationGate } from "../../schema/gate";
import { USER_DATA_CODE_VERSION, USER_DATA_STEPS } from "../../schema/userData";
import { conditionalUpdate } from "../../sql/occ";

// Misattribution is the failure this file exists for, and it is the one #26
// recorded against the D1 stack: there, a batch of statements was guarded by
// inserts into an `_occ_guard` table whose CHECK fired somewhere in the batch,
// so "which write lost" had to be inferred from a driver message. Nothing here
// infers anything — `UPDATE … RETURNING 1` reports its own matched-row count,
// inside the statement that did the matching.

let seq = 0;
function fresh<T>(fn: (io: { sql: SqlStorage; ctx: DurableObjectState }) => T) {
  seq += 1;
  const name = `occ-${seq}`;
  return inUserData(name, (io) => {
    runMigrationGate(io.ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, name);
    return fn(io);
  });
}

const MEMO_INSERT =
  "INSERT INTO memos (id, body, latest_revision_number, posted_at, status, trashed_at, purge_after, version, updated_at) VALUES (?, ?, 1, 100, 'active', NULL, NULL, ?, 100)";

function saveMemo(sql: SqlStorage, id: string, body: string, expected: number) {
  conditionalUpdate(
    sql,
    "UPDATE memos SET body = ?, version = ? WHERE id = ? AND version = ? RETURNING 1",
    [body, expected + 1, id, expected],
    `memo ${id}`,
  );
}

function bodyOf(sql: SqlStorage, id: string): string | null {
  const rows = sql
    .exec<{ body: string }>("SELECT body FROM memos WHERE id = ?", id)
    .toArray();
  return rows[0]?.body ?? null;
}

describe("DO-side OCC", () => {
  it("maps a stale expected version to ConflictError(OPTIMISTIC_LOCK_FAILURE)", async () => {
    const error = await fresh(({ sql }) => {
      sql.exec(MEMO_INSERT, "m1", "first", 0);
      // Someone else already moved it to version 1.
      sql.exec("UPDATE memos SET version = 1 WHERE id = 'm1'");
      try {
        saveMemo(sql, "m1", "second", 0);
        return null;
      } catch (caught) {
        return caught instanceof ConflictError
          ? { code: caught.code, message: caught.message }
          : { code: "not-a-conflict-error", message: String(caught) };
      }
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("OPTIMISTIC_LOCK_FAILURE");
    expect(error?.message).toContain("memo m1");
  });

  it("does not read another statement's success as its own", async () => {
    // The shape #26 was about: two guarded writes in one transaction, one of
    // which matches. A judgement taken from the transaction rather than from
    // the statement would call the losing write a success.
    const outcome = await fresh(({ ctx, sql }) => {
      sql.exec(MEMO_INSERT, "hit", "a", 0);
      sql.exec(MEMO_INSERT, "miss", "b", 5);
      let caught: unknown = null;
      try {
        ctx.storage.transactionSync(() => {
          saveMemo(sql, "hit", "a2", 0);
          saveMemo(sql, "miss", "b2", 0);
        });
      } catch (error) {
        caught = error;
      }
      return {
        code: caught instanceof ConflictError ? caught.code : null,
        message: caught instanceof Error ? caught.message : "",
        hit: bodyOf(sql, "hit"),
        miss: bodyOf(sql, "miss"),
      };
    });
    expect(outcome.code).toBe("OPTIMISTIC_LOCK_FAILURE");
    expect(outcome.message).toContain("memo miss");
  });

  it("rolls the earlier write back and names the row that actually lost", async () => {
    const outcome = await fresh(({ ctx, sql }) => {
      sql.exec(MEMO_INSERT, "hit", "a", 0);
      sql.exec(MEMO_INSERT, "miss", "b", 5);
      let caught: unknown = null;
      try {
        ctx.storage.transactionSync(() => {
          saveMemo(sql, "hit", "a2", 0);
          saveMemo(sql, "miss", "b2", 0);
        });
      } catch (error) {
        caught = error;
      }
      return {
        message: caught instanceof Error ? caught.message : "",
        hit: bodyOf(sql, "hit"),
        miss: bodyOf(sql, "miss"),
      };
    });
    // The successful update is gone: the transaction is the boundary.
    expect(outcome.hit).toBe("a");
    expect(outcome.miss).toBe("b");
    // …and the error still points at the second write, not the first.
    expect(outcome.message).toContain("memo miss");
    expect(outcome.message).not.toContain("memo hit");
  });

  it("leaves no guard state behind on the success path", async () => {
    const after = await fresh(({ ctx, sql }) => {
      sql.exec(MEMO_INSERT, "m1", "first", 0);
      ctx.storage.transactionSync(() => {
        saveMemo(sql, "m1", "second", 0);
      });
      return {
        body: bodyOf(sql, "m1"),
        // There is no `_occ_guard`, and no table like it: the whole mechanism
        // that made misattribution possible is absent from the schema.
        guardTables: sql
          .exec<{ name: string }>(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND (name LIKE '%occ%' OR name LIKE '%guard%')`,
          )
          .toArray()
          .map((row) => row.name),
      };
    });
    expect(after.body).toBe("second");
    expect(after.guardTables).toEqual([]);
  });
});
