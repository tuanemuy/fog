import type { SqlStorage } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { inUserData } from "../../__tests__/doHarness";
import { runMigrationGate } from "../../schema/gate";
import { USER_DATA_CODE_VERSION, USER_DATA_STEPS } from "../../schema/userData";
import { matchFts, matchShortKeyword } from "../probe";
import { upsertSearchEntry } from "../projection";

// Standing evidence for `.adr/003`: `tokenize='trigram'` is not documented for
// workerd, so measurement is the only ground the decision stands on. These
// cases were first run as the #37 step-1 spike; keeping them permanent is what
// makes a workerd upgrade that breaks the tokenizer visible in CI.

const SEED = [
  { id: "a", body: "東京駅の構内を歩く", timestamp: 300 },
  { id: "b", body: "東京駅の周辺を歩く", timestamp: 200 },
  { id: "c", body: "京都駅の周辺を歩く", timestamp: 100 },
];

let seq = 0;
function seeded<T>(fn: (sql: SqlStorage) => T) {
  seq += 1;
  const name = `tokenizer-${seq}`;
  return inUserData(name, ({ ctx, sql }) => {
    runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, name);
    ctx.storage.transactionSync(() => {
      for (const row of SEED) {
        sql.exec(
          "INSERT INTO memos (id, body, latest_revision_number, posted_at, status, trashed_at, purge_after, version, updated_at) VALUES (?, ?, 1, ?, 'active', NULL, NULL, 0, ?)",
          row.id,
          row.body,
          row.timestamp,
          row.timestamp,
        );
        upsertSearchEntry(sql, {
          id: row.id,
          type: "memo",
          topicId: null,
          title: "",
          body: row.body,
          timestamp: row.timestamp,
          sourceIds: [],
        });
      }
    });
    return fn(sql);
  });
}

describe("FTS5 trigram tokenizer", () => {
  it("matches a 3-character Japanese keyword", async () => {
    const hits = await seeded((sql) => matchFts(sql, "東京駅", 10));
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b"]);
  });

  it("ranks with bm25(search_fts, 3.0, 1.0) without throwing", async () => {
    const hits = await seeded((sql) => matchFts(sql, "駅の周辺", 10));
    expect(hits.map((h) => h.id).sort()).toEqual(["b", "c"]);
  });

  it("matches nothing for a 2-character keyword", async () => {
    // Not a bug — trigram indexes 3-codepoint sequences, which is exactly why
    // the `instr()` fallback below exists. A change here means the fallback
    // threshold has to move with it.
    const hits = await seeded((sql) => matchFts(sql, "周辺", 10));
    expect(hits).toHaveLength(0);
  });

  it("falls back to instr() for a 2-character keyword", async () => {
    const hits = await seeded((sql) => matchShortKeyword(sql, "東京", 10));
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b"]);
  });

  it("falls back to instr() for a 1-character keyword", async () => {
    const hits = await seeded((sql) => matchShortKeyword(sql, "駅", 10));
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("pages FTS results without repeating or losing rows", async () => {
    const pages = await seeded((sql) => [
      matchFts(sql, "駅の周辺", 1, 0),
      matchFts(sql, "駅の周辺", 1, 1),
      matchFts(sql, "駅の周辺", 1, 2),
    ]);
    expect(pages[0]).toHaveLength(1);
    expect(pages[1]).toHaveLength(1);
    expect(pages[2]).toHaveLength(0);
    expect(pages[0]?.[0]?.id).not.toBe(pages[1]?.[0]?.id);
    expect([pages[0]?.[0]?.id, pages[1]?.[0]?.id].sort()).toEqual(["b", "c"]);
  });

  it("pages the short-keyword fallback the same way", async () => {
    const pages = await seeded((sql) => [
      matchShortKeyword(sql, "東京", 1, 0),
      matchShortKeyword(sql, "東京", 1, 1),
      matchShortKeyword(sql, "東京", 1, 2),
    ]);
    expect(pages[0]?.[0]?.id).toBe("a");
    expect(pages[1]?.[0]?.id).toBe("b");
    expect(pages[2]).toHaveLength(0);
  });

  it("normalizes the query the same way as the index", async () => {
    const hits = await seeded((sql) => matchFts(sql, " 東京駅 ", 10));
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b"]);
  });
});
