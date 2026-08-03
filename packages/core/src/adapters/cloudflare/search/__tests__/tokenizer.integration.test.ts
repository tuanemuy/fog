import type { SqlStorage } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { inUserData } from "../../__tests__/doHarness";
import { runMigrationGate } from "../../schema/gate";
import { USER_DATA_CODE_VERSION, USER_DATA_STEPS } from "../../schema/userData";
import { matchFts, matchShortKeyword } from "../probe";
import { upsertSearchEntry } from "../projection";

// Standing evidence for `.adr/003`: `tokenize='trigram'` is not documented for
// workerd, so measurement is the only ground the decision stands on. Keeping
// these cases permanent is what makes a workerd upgrade that breaks the
// tokenizer visible in CI.

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

/**
 * A corpus built so that ranking is the only thing that can order it.
 *
 * `title-hit` carries the keyword in its **title** and the *older* timestamp;
 * `body-hit` carries it in its body and the newer one. `ORDER BY bm25(...),
 * e.timestamp DESC` therefore puts `body-hit` first on every tie — so
 * `title-hit` leading is attributable to the 3.0 title weight and to nothing
 * else. The seeded corpus for the cases above has no titles at all, so that
 * weight is unexercised there.
 */
const RANKED = [
  {
    id: "title-hit",
    title: "東京駅の案内",
    body: "詳しい説明はこの案内の続きに書かれている",
    timestamp: 100,
  },
  {
    id: "body-hit",
    title: "案内",
    body: "詳しい説明は東京駅の窓口に書かれている",
    timestamp: 300,
  },
];

function ranked<T>(fn: (sql: SqlStorage) => T) {
  seq += 1;
  const name = `tokenizer-ranked-${seq}`;
  return inUserData(name, ({ ctx, sql }) => {
    runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, name);
    ctx.storage.transactionSync(() => {
      for (const row of RANKED) {
        upsertSearchEntry(sql, {
          id: row.id,
          type: "document",
          topicId: null,
          title: row.title,
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

  it("returns the set a phrase matches", async () => {
    const hits = await seeded((sql) => matchFts(sql, "駅の周辺", 10));
    expect(hits.map((h) => h.id).sort()).toEqual(["b", "c"]);
  });

  it("ranks a title hit above a body hit through bm25's 3.0 title weight", async () => {
    const hits = await ranked((sql) => matchFts(sql, "東京駅", 10));
    // Not sorted: the order *is* the assertion. Both rows match, and every
    // tie-breaker after `bm25(...)` favours `body-hit`, so this ordering can
    // only come from the ranking function and its column weights. Dropping
    // `ORDER BY bm25(...)`, reversing it, or levelling the weights to
    // `(1.0, 1.0)` each flip it.
    expect(hits.map((hit) => hit.id)).toEqual(["title-hit", "body-hit"]);
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

  it("treats FTS5 operators in a keyword as text rather than syntax", async () => {
    // Every one of these parses as an expression on the right-hand side of
    // `MATCH`: an unbalanced quote is a syntax error, `AND` / `NEAR` are
    // operators, `*` is a prefix marker and `(` opens a group. Unquoted, each
    // surfaces to the user as a 500 on any search containing it — and the
    // trigram tokenizer indexes punctuation, so symbols in a query are ordinary
    // search terms rather than an exotic case.
    const keywords = [
      '東京駅"',
      '"東京駅',
      "東京駅*",
      "東京 AND 駅",
      "東京駅 NEAR 周辺",
      "(東京駅",
      "東京:駅",
      "^東京駅",
    ];
    const results = await seeded((sql) =>
      keywords.map((keyword) => matchFts(sql, keyword, 10).length),
    );
    expect(results).toHaveLength(keywords.length);
    // A quoted phrase that is not in the corpus simply matches nothing; the
    // assertion is that asking never throws.
    for (const count of results) expect(count).toBeGreaterThanOrEqual(0);
  });

  it("still matches a plain keyword once it is quoted as a phrase", async () => {
    const hits = await seeded((sql) => matchFts(sql, "東京駅", 10));
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b"]);
  });
});
