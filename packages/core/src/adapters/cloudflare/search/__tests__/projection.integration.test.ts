import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { inUserData } from "../../__tests__/doHarness";
import { runMigrationGate } from "../../schema/gate";
import { USER_DATA_CODE_VERSION, USER_DATA_STEPS } from "../../schema/userData";
import { matchFts } from "../probe";
import { removeSearchEntry, upsertSearchEntry } from "../projection";

// The point of every case here is that the body row and the index move
// together, or not at all. Assertions are phrased as "does this keyword still
// match", never as "were two statements issued": swapping the FTS5 delete
// command for `DELETE FROM search_fts` passes the latter and fails the former.

let seq = 0;
function fresh<T>(fn: (io: { sql: SqlStorage; ctx: DurableObjectState }) => T) {
  seq += 1;
  const name = `projection-${seq}`;
  return inUserData(name, (io) => {
    runMigrationGate(io.ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, name);
    return fn(io);
  });
}

function ids(hits: readonly { id: string }[]): string[] {
  return hits.map((h) => h.id).sort();
}

const MEMO_INSERT =
  "INSERT INTO memos (id, body, latest_revision_number, posted_at, status, trashed_at, purge_after, version, updated_at) VALUES (?, ?, 1, ?, 'active', NULL, NULL, 0, ?)";

const DOC_INSERT =
  "INSERT INTO documents (id, topic_id, title, body, latest_revision_number, status, trashed_at, purge_after, trashed_with, version, created_at, updated_at) VALUES (?, 't1', ?, ?, 1, 'active', NULL, NULL, NULL, 0, 1, 1)";

describe("search projection — memos", () => {
  it("commits the body row and the index together", async () => {
    const result = await fresh(({ ctx, sql }) => {
      ctx.storage.transactionSync(() => {
        sql.exec(MEMO_INSERT, "m1", "東京駅の構内を歩く", 100, 100);
        upsertSearchEntry(sql, {
          id: "m1",
          type: "memo",
          topicId: null,
          title: "",
          body: "東京駅の構内を歩く",
          timestamp: 100,
          sourceIds: [],
        });
      });
      return {
        memos: sql.exec("SELECT id FROM memos").toArray().length,
        entries: sql.exec("SELECT id FROM search_entries").toArray().length,
        hits: ids(matchFts(sql, "東京駅", 10)),
      };
    });
    expect(result.memos).toBe(1);
    expect(result.entries).toBe(1);
    expect(result.hits).toEqual(["m1"]);
  });

  it("leaves nothing behind when the transaction throws part-way", async () => {
    const result = await fresh(({ ctx, sql }) => {
      try {
        ctx.storage.transactionSync(() => {
          sql.exec(MEMO_INSERT, "m1", "東京駅の構内を歩く", 100, 100);
          upsertSearchEntry(sql, {
            id: "m1",
            type: "memo",
            topicId: null,
            title: "",
            body: "東京駅の構内を歩く",
            timestamp: 100,
            sourceIds: [],
          });
          throw new Error("boom");
        });
      } catch {
        // expected
      }
      return {
        memos: sql.exec("SELECT id FROM memos").toArray().length,
        entries: sql.exec("SELECT id FROM search_entries").toArray().length,
        hits: matchFts(sql, "東京駅", 10).length,
      };
    });
    expect(result).toEqual({ memos: 0, entries: 0, hits: 0 });
  });

  it("stops matching the previous body after an update", async () => {
    const result = await fresh(({ ctx, sql }) => {
      ctx.storage.transactionSync(() => {
        sql.exec(MEMO_INSERT, "m1", "東京駅の構内を歩く", 100, 100);
        upsertSearchEntry(sql, {
          id: "m1",
          type: "memo",
          topicId: null,
          title: "",
          body: "東京駅の構内を歩く",
          timestamp: 100,
          sourceIds: [],
        });
      });
      ctx.storage.transactionSync(() => {
        sql.exec(
          "UPDATE memos SET body = ? WHERE id = ?",
          "京都駅の周辺",
          "m1",
        );
        upsertSearchEntry(sql, {
          id: "m1",
          type: "memo",
          topicId: null,
          title: "",
          body: "京都駅の周辺",
          timestamp: 100,
          sourceIds: [],
        });
      });
      return {
        stale: matchFts(sql, "東京駅", 10).length,
        fresh: ids(matchFts(sql, "京都駅", 10)),
        entries: sql.exec("SELECT id FROM search_entries").toArray().length,
      };
    });
    expect(result.stale).toBe(0);
    expect(result.fresh).toEqual(["m1"]);
    expect(result.entries).toBe(1);
  });

  it("drops the entry on soft delete and re-creates it on restore", async () => {
    const result = await fresh(({ ctx, sql }) => {
      const project = () =>
        upsertSearchEntry(sql, {
          id: "m1",
          type: "memo",
          topicId: null,
          title: "",
          body: "東京駅の構内を歩く",
          timestamp: 100,
          sourceIds: [],
        });
      ctx.storage.transactionSync(() => {
        sql.exec(MEMO_INSERT, "m1", "東京駅の構内を歩く", 100, 100);
        project();
      });
      ctx.storage.transactionSync(() => {
        sql.exec(
          "UPDATE memos SET status='trashed', trashed_at=?, purge_after=? WHERE id=?",
          200,
          300,
          "m1",
        );
        removeSearchEntry(sql, "m1");
      });
      const afterTrash = {
        hits: matchFts(sql, "東京駅", 10).length,
        entries: sql.exec("SELECT id FROM search_entries").toArray().length,
      };
      ctx.storage.transactionSync(() => {
        sql.exec(
          "UPDATE memos SET status='active', trashed_at=NULL, purge_after=NULL WHERE id=?",
          "m1",
        );
        project();
      });
      return {
        afterTrash,
        afterRestore: ids(matchFts(sql, "東京駅", 10)),
      };
    });
    expect(result.afterTrash).toEqual({ hits: 0, entries: 0 });
    expect(result.afterRestore).toEqual(["m1"]);
  });

  it("drops the entry on hard delete", async () => {
    const result = await fresh(({ ctx, sql }) => {
      ctx.storage.transactionSync(() => {
        sql.exec(MEMO_INSERT, "m1", "東京駅の構内を歩く", 100, 100);
        upsertSearchEntry(sql, {
          id: "m1",
          type: "memo",
          topicId: null,
          title: "",
          body: "東京駅の構内を歩く",
          timestamp: 100,
          sourceIds: [],
        });
      });
      ctx.storage.transactionSync(() => {
        removeSearchEntry(sql, "m1");
        sql.exec("DELETE FROM memos WHERE id = ?", "m1");
      });
      return {
        memos: sql.exec("SELECT id FROM memos").toArray().length,
        entries: sql.exec("SELECT id FROM search_entries").toArray().length,
        hits: matchFts(sql, "東京駅", 10).length,
      };
    });
    expect(result).toEqual({ memos: 0, entries: 0, hits: 0 });
  });
});

describe("search projection — documents", () => {
  function seedTopic(sql: SqlStorage): void {
    sql.exec(
      "INSERT INTO topics (id, name, description, status, trashed_at, purge_after, was_archived, version, created_at, updated_at) VALUES ('t1','topic',NULL,'active',NULL,NULL,NULL,0,1,1)",
    );
  }

  const project = (sql: SqlStorage, title: string, body: string) =>
    upsertSearchEntry(sql, {
      id: "d1",
      type: "document",
      topicId: "t1",
      title,
      body,
      timestamp: 100,
      sourceIds: ["m1"],
    });

  it("commits the body row and the index together", async () => {
    const result = await fresh(({ ctx, sql }) => {
      ctx.storage.transactionSync(() => {
        seedTopic(sql);
        sql.exec(DOC_INSERT, "d1", "東京駅の資料", "構内図をまとめる");
        project(sql, "東京駅の資料", "構内図をまとめる");
      });
      return {
        documents: sql.exec("SELECT id FROM documents").toArray().length,
        hits: ids(matchFts(sql, "東京駅", 10)),
        sourceIds: sql
          .exec<{ source_ids: string }>(
            "SELECT source_ids FROM search_entries WHERE id='d1'",
          )
          .one().source_ids,
      };
    });
    expect(result.documents).toBe(1);
    expect(result.hits).toEqual(["d1"]);
    expect(result.sourceIds).toBe('["m1"]');
  });

  it("leaves nothing behind when the transaction throws part-way", async () => {
    const result = await fresh(({ ctx, sql }) => {
      seedTopic(sql);
      try {
        ctx.storage.transactionSync(() => {
          sql.exec(DOC_INSERT, "d1", "東京駅の資料", "構内図をまとめる");
          project(sql, "東京駅の資料", "構内図をまとめる");
          throw new Error("boom");
        });
      } catch {
        // expected
      }
      return {
        documents: sql.exec("SELECT id FROM documents").toArray().length,
        entries: sql.exec("SELECT id FROM search_entries").toArray().length,
        hits: matchFts(sql, "東京駅", 10).length,
      };
    });
    expect(result).toEqual({ documents: 0, entries: 0, hits: 0 });
  });

  it("stops matching the previous title after an update", async () => {
    const result = await fresh(({ ctx, sql }) => {
      ctx.storage.transactionSync(() => {
        seedTopic(sql);
        sql.exec(DOC_INSERT, "d1", "東京駅の資料", "構内図をまとめる");
        project(sql, "東京駅の資料", "構内図をまとめる");
      });
      ctx.storage.transactionSync(() => {
        sql.exec(
          "UPDATE documents SET title = ? WHERE id = ?",
          "京都駅の資料",
          "d1",
        );
        project(sql, "京都駅の資料", "構内図をまとめる");
      });
      return {
        stale: matchFts(sql, "東京駅", 10).length,
        fresh: ids(matchFts(sql, "京都駅", 10)),
      };
    });
    expect(result.stale).toBe(0);
    expect(result.fresh).toEqual(["d1"]);
  });

  it("drops the entry on soft delete and re-creates it on restore", async () => {
    const result = await fresh(({ ctx, sql }) => {
      ctx.storage.transactionSync(() => {
        seedTopic(sql);
        sql.exec(DOC_INSERT, "d1", "東京駅の資料", "構内図をまとめる");
        project(sql, "東京駅の資料", "構内図をまとめる");
      });
      ctx.storage.transactionSync(() => removeSearchEntry(sql, "d1"));
      const afterTrash = matchFts(sql, "東京駅", 10).length;
      ctx.storage.transactionSync(() =>
        project(sql, "東京駅の資料", "構内図をまとめる"),
      );
      return { afterTrash, afterRestore: ids(matchFts(sql, "東京駅", 10)) };
    });
    expect(result.afterTrash).toBe(0);
    expect(result.afterRestore).toEqual(["d1"]);
  });

  it("drops the entry on hard delete", async () => {
    const result = await fresh(({ ctx, sql }) => {
      ctx.storage.transactionSync(() => {
        seedTopic(sql);
        sql.exec(DOC_INSERT, "d1", "東京駅の資料", "構内図をまとめる");
        project(sql, "東京駅の資料", "構内図をまとめる");
      });
      ctx.storage.transactionSync(() => {
        removeSearchEntry(sql, "d1");
        sql.exec("DELETE FROM documents WHERE id = 'd1'");
      });
      return {
        documents: sql.exec("SELECT id FROM documents").toArray().length,
        entries: sql.exec("SELECT id FROM search_entries").toArray().length,
        hits: matchFts(sql, "東京駅", 10).length,
      };
    });
    expect(result).toEqual({ documents: 0, entries: 0, hits: 0 });
  });
});

describe("search projection — normalization", () => {
  it("indexes the normalized text, not the original", async () => {
    const result = await fresh(({ ctx, sql }) => {
      ctx.storage.transactionSync(() => {
        sql.exec(MEMO_INSERT, "m1", "  ＴＯＫＹＯ駅  ", 100, 100);
        upsertSearchEntry(sql, {
          id: "m1",
          type: "memo",
          topicId: null,
          title: "",
          body: "  ＴＯＫＹＯ駅  ",
          timestamp: 100,
          sourceIds: [],
        });
      });
      return {
        stored: sql
          .exec<{ body: string }>("SELECT body FROM search_entries")
          .one().body,
        hits: ids(matchFts(sql, "TOKYO", 10)),
      };
    });
    expect(result.stored).toBe("TOKYO駅");
    expect(result.hits).toEqual(["m1"]);
  });
});
