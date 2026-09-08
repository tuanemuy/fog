import { inUserDataStorage } from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import {
  decodeSearchCursor,
  encodeSearchCursor,
} from "@repo/core/adapters/cloudflare/stores/searchCursor";
import {
  createSearchIndex,
  SEARCH_SNAPSHOT_LIMIT,
  SEARCH_SNAPSHOT_TTL_MS,
} from "@repo/core/adapters/cloudflare/stores/searchIndex";
import {
  isNotFoundError,
  isSystemError,
  isValidationError,
} from "@repo/core/application/errors";
import { trashDocument } from "@repo/core/application/knowledge/trashDocument";
import { trashTopic } from "@repo/core/application/knowledge/trashTopic";
import { updateTopic } from "@repo/core/application/knowledge/updateTopic";
import { editMemo } from "@repo/core/application/memo/editMemo";
import { softDeleteMemo } from "@repo/core/application/memo/softDeleteMemo";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { SearchQuery } from "@repo/core/domain/search/valueObject";
import { describe, expect, it } from "vitest";
import {
  document,
  expectCode,
  post,
  topic,
  userActor,
} from "../../knowledge/__tests__/knowledgeFixtures";
import { postAt } from "../../memo/__tests__/memoFixtures";
import { type SearchInput, search } from "../search";

type Container = ReturnType<typeof createTestContainer>;

function finder(container: Container, userId: string) {
  return (
    keyword: string,
    extra: Partial<Omit<SearchInput, "userId" | "keyword">> = {},
  ) =>
    search({
      container,
      input: { userId, keyword, limit: 20, ...extra },
    });
}

async function setUp() {
  const container = createTestContainer();
  const { userId } = await registerTestUser(container);
  return { container, userId, find: finder(container, userId) };
}

describe("search — hits and their shape", () => {
  it("(a) crosses memos and documents, with facts only, sources both ways, and the topic name", async () => {
    const { container, userId, find } = await setUp();
    const t = await topic(container, userId, "検索テストA");
    const lone = await post(
      container,
      userId,
      "fogsearch 横断検索用の単独メモ",
    );
    const cited = await post(container, userId, "fogsearch 検索Aの出典メモ");
    const doc = await document(container, userId, t.id, {
      title: "資料",
      body: "fogsearch 検索Aの資料本文",
      sourceMemoIds: [cited.id],
    });
    const out = await find("fogsearch");
    expect(out.count).toBe(3);
    expect(out.nextCursor).toBeNull();
    const byId = new Map(out.items.map((item) => [item.id, item]));
    expect(byId.get(lone.id)).toEqual({
      type: "memo",
      id: lone.id,
      snippet: "fogsearch 横断検索用の単独メモ",
      timestamp: lone.postedAt,
      sourceOfDocumentIds: [],
    });
    expect(byId.get(cited.id)).toMatchObject({
      type: "memo",
      sourceOfDocumentIds: [doc.id],
    });
    expect(byId.get(doc.id)).toEqual({
      type: "document",
      id: doc.id,
      snippet: "資料 fogsearch 検索Aの資料本文",
      timestamp: doc.updatedAt,
      topicId: t.id,
      topicName: "検索テストA",
      sourceMemoIds: [cited.id],
    });
  });

  it("(b) names every topic the documents belong to, and keeps a long body to an excerpt", async () => {
    const { container, userId, find } = await setUp();
    const a = await topic(container, userId, "A");
    const b = await topic(container, userId, "B");
    await document(container, userId, a.id, { body: "fogmulti in A" });
    await document(container, userId, b.id, { body: "fogmulti in B" });
    const long = await post(
      container,
      userId,
      `${"前".repeat(300)} fogmulti ${"後".repeat(300)}`,
    );
    const out = await find("fogmulti");
    expect(
      out.items
        .filter((item) => item.type === "document")
        .map((item) => item.topicName)
        .sort(),
    ).toEqual(["A", "B"]);
    const memo = out.items.find((item) => item.id === long.id);
    expect(memo?.snippet).toContain("fogmulti");
    expect(memo?.snippet.length).toBeLessThan(150);
    expect(memo?.snippet.startsWith("…")).toBe(true);
    expect(memo?.snippet.endsWith("…")).toBe(true);
  });
});

describe("search — scope and exclusions", () => {
  it("(c) narrows to the topic's documents and their source memos; nothing there is an empty page", async () => {
    const { container, userId, find } = await setUp();
    const inside = await topic(container, userId, "inside");
    const outside = await topic(container, userId, "outside");
    const source = await post(container, userId, "fogscope source memo");
    const stray = await post(container, userId, "fogscope stray memo");
    const inDoc = await document(container, userId, inside.id, {
      body: "fogscope inside doc",
      sourceMemoIds: [source.id],
    });
    await document(container, userId, outside.id, {
      body: "fogscope outside doc",
    });
    const scoped = await find("fogscope", { topicId: inside.id });
    expect(scoped.items.map((item) => item.id).sort()).toEqual(
      [source.id, inDoc.id].sort(),
    );
    expect(scoped.count).toBe(2);
    expect(scoped.items.map((i) => i.id)).not.toContain(stray.id);
    const nothing = await find("fogscope unrelated words", {
      topicId: inside.id,
    });
    expect(nothing).toEqual({ items: [], count: 0, nextCursor: null });
  });

  it("(d) still hits under an archived topic, scoped or not", async () => {
    const { container, userId, find } = await setUp();
    const t = await topic(container, userId, "done");
    const source = await post(container, userId, "fogarch source");
    const doc = await document(container, userId, t.id, {
      body: "fogarch doc",
      sourceMemoIds: [source.id],
    });
    await updateTopic({
      container,
      input: { userId, topicId: t.id, archived: true },
    });
    expect((await find("fogarch")).items.map((i) => i.id).sort()).toEqual(
      [source.id, doc.id].sort(),
    );
    expect(
      (await find("fogarch", { topicId: t.id })).items.map((i) => i.id).sort(),
    ).toEqual([source.id, doc.id].sort());
  });

  it("(e) never shows the trash — neither as a hit nor as a source id", async () => {
    const { container, userId, find } = await setUp();
    const t = await topic(container, userId, "T");
    const gone = await topic(container, userId, "gone");
    const memoGone = await post(container, userId, "fogtrash memo gone");
    const memoKept = await post(container, userId, "fogtrash memo kept");
    const memoCited = await post(container, userId, "fogtrash cited by two");
    const docGone = await document(container, userId, t.id, {
      body: "fogtrash doc gone",
      sourceMemoIds: [memoCited.id, memoGone.id],
    });
    const docKept = await document(container, userId, t.id, {
      body: "fogtrash doc kept",
      sourceMemoIds: [memoCited.id, memoGone.id, memoKept.id],
    });
    const docSet = await document(container, userId, gone.id, {
      body: "fogtrash in set",
    });
    await softDeleteMemo({ container, input: { userId, memoId: memoGone.id } });
    await trashDocument({
      container,
      input: { userId, documentId: docGone.id },
    });
    await trashTopic({ container, input: { userId, topicId: gone.id } });

    const out = await find("fogtrash");
    const ids = out.items.map((i) => i.id);
    expect(ids).not.toContain(memoGone.id);
    expect(ids).not.toContain(docGone.id);
    expect(ids).not.toContain(docSet.id);
    expect(ids.sort()).toEqual([memoKept.id, memoCited.id, docKept.id].sort());
    const cited = out.items.find((i) => i.id === memoCited.id);
    expect(cited).toMatchObject({ sourceOfDocumentIds: [docKept.id] });
    const kept = out.items.find((i) => i.id === docKept.id);
    expect(kept).toMatchObject({
      sourceMemoIds: [memoCited.id, memoKept.id].sort(),
    });
  });

  it("(f) is closed to the user's own Durable Object", async () => {
    const container = createTestContainer();
    const a = await registerTestUser(container);
    const b = await registerTestUser(container);
    await post(container, b.userId, "fogother only B has this");
    expect(await finder(container, a.userId)("fogother")).toEqual({
      items: [],
      count: 0,
      nextCursor: null,
    });
    expect((await finder(container, b.userId)("fogother")).count).toBe(1);
  });
});

describe("search — keyword handling", () => {
  it("(g) trims, answers nothing as an empty page, and allows exactly 500 code points", async () => {
    const { container, userId, find } = await setUp();
    const memo = await post(container, userId, "fogtrim padded");
    expect((await find("  fogtrim  ")).items.map((i) => i.id)).toEqual([
      memo.id,
    ]);
    expect(await find("zzz存在しない検索語zzz")).toEqual({
      items: [],
      count: 0,
      nextCursor: null,
    });
    expect((await find("あ".repeat(500))).count).toBe(0);
  });

  it("(i) refuses an empty, blank or 501-character keyword, a bad limit and a bad topic id", async () => {
    const { container, find } = await setUp();
    await expectCode(find(""), isBusinessRuleError, "EMPTY_KEYWORD");
    await expectCode(find("   "), isBusinessRuleError, "EMPTY_KEYWORD");
    await expectCode(
      find("あ".repeat(501)),
      isBusinessRuleError,
      "KEYWORD_TOO_LONG",
    );
    await expectCode(
      find("fog", { limit: 0 }),
      isValidationError,
      "INVALID_LIMIT",
    );
    await expectCode(
      find("fog", { limit: 101 }),
      isValidationError,
      "INVALID_LIMIT",
    );
    await expectCode(
      find("fog", { topicId: " " }),
      isBusinessRuleError,
      "INVALID_TOPIC_ID",
    );
    await expectCode(
      search({
        container,
        input: { userId: " ", keyword: "fog", limit: 1 },
      }).catch((e) => {
        throw e;
      }),
      (error) =>
        isBusinessRuleError(error) ||
        isValidationError(error) ||
        isSystemError(error),
    );
  });

  it("(k) hits right after a post, follows an edit exactly, and forgets a deleted memo", async () => {
    const { container, userId, find } = await setUp();
    const memo = await post(container, userId, "本文に旧語を含むメモ fognow");
    expect((await find("fognow")).items.map((i) => i.id)).toEqual([memo.id]);
    expect((await find("旧語")).count).toBe(1);
    await editMemo({
      container,
      input: {
        userId,
        memoId: memo.id,
        body: "本文に新語を含むメモ fognow",
        expectedVersion: 0,
        actor: userActor(userId),
      },
    });
    expect((await find("旧語")).count).toBe(0);
    expect((await find("新語")).items[0]?.snippet).toBe(
      "本文に新語を含むメモ fognow",
    );
    await softDeleteMemo({ container, input: { userId, memoId: memo.id } });
    expect((await find("fognow")).count).toBe(0);
  });

  it("(l)(m) matches Japanese substrings through trigrams, and one or two characters through the scan", async () => {
    const { container, userId, find } = await setUp();
    const long = await post(
      container,
      userId,
      "蒸留器の温度管理についての覚え書き",
    );
    const dog = await post(container, userId, "犬の散歩ルートを見直す");
    expect((await find("温度")).items.map((i) => i.id)).toEqual([long.id]);
    expect((await find("犬")).items.map((i) => i.id)).toEqual([dog.id]);
    expect((await find("散歩")).items.map((i) => i.id)).toEqual([dog.id]);
    expect((await find("犬")).items[0]?.snippet).toBe("犬の散歩ルートを見直す");
    const t = await topic(container, userId, "犬");
    const doc = await document(container, userId, t.id, {
      title: "散歩",
      body: "本文",
      sourceMemoIds: [dog.id],
    });
    expect(
      (await find("散歩", { topicId: t.id })).items.map((i) => i.id).sort(),
    ).toEqual([dog.id, doc.id].sort());
  });

  it("(n) folds width and composition on both sides, and shows the original text", async () => {
    const { container, userId, find } = await setUp();
    const half = await post(container, userId, "半角の fog123 を含むメモ");
    const full = await post(
      container,
      userId,
      "全角表記の ｆｏｇ１２３ を含むメモ",
    );
    const composed = await post(container, userId, "合成済みの が を含む");
    const decomposed = await post(container, userId, "結合文字列の が を含む");
    for (const keyword of ["fog123", "ｆｏｇ１２３"]) {
      const out = await find(keyword);
      expect(out.items.map((i) => i.id).sort()).toEqual(
        [half.id, full.id].sort(),
      );
      expect(out.items.find((i) => i.id === full.id)?.snippet).toBe(
        "全角表記の ｆｏｇ１２３ を含むメモ",
      );
    }
    for (const keyword of ["が", "が"]) {
      expect((await find(keyword)).items.map((i) => i.id).sort()).toEqual(
        [composed.id, decomposed.id].sort(),
      );
    }
  });

  it("(o) ranks a title hit above a body hit, and breaks ties on timestamp DESC, type, id", async () => {
    const { container, userId, find } = await setUp();
    const t = await topic(container, userId, "rank");
    const inBody = await document(container, userId, t.id, {
      title: "重み付け比較用ドキュメント",
      body: "本文にだけ fogrank を含む",
    });
    const inTitle = await document(container, userId, t.id, {
      title: "fogrank 重み付け確認用ドキュメント",
      body: "本文には含まない",
    });
    expect((await find("fogrank")).items.map((i) => i.id)).toEqual([
      inTitle.id,
      inBody.id,
    ]);

    const older = await postAt(
      container,
      userId,
      "fogtie same words",
      new Date("2026-01-01T00:00:00Z"),
    );
    const newer = await postAt(
      container,
      userId,
      "fogtie same words",
      new Date("2026-01-02T00:00:00Z"),
    );
    const middle = await postAt(
      container,
      userId,
      "fogtie same words",
      new Date("2026-01-01T12:00:00Z"),
    );
    for (let n = 0; n < 3; n += 1) {
      expect((await find("fogtie")).items.map((i) => i.id)).toEqual([
        newer.id,
        middle.id,
        older.id,
      ]);
    }
  });

  it("(p) refuses an unknown or trashed topic instead of answering nothing", async () => {
    const { container, userId, find } = await setUp();
    await expectCode(
      find("fog", { topicId: "nope" }),
      isNotFoundError,
      "TOPIC_NOT_FOUND",
    );
    const t = await topic(container, userId, "gone");
    await trashTopic({ container, input: { userId, topicId: t.id } });
    await expectCode(
      find("fog", { topicId: t.id }),
      isNotFoundError,
      "TOPIC_NOT_FOUND",
    );
  });
});

describe("search — snapshot paging", () => {
  it("(h) reads one frozen set across pages while rows are added and edited; count holds", async () => {
    const { container, userId, find } = await setUp();
    const memos = [];
    for (let n = 1; n <= 5; n += 1) {
      memos.push(await post(container, userId, `fogpage 連番メモ 00${n}`));
    }
    const page1 = await find("fogpage", { limit: 2 });
    expect(page1.count).toBe(5);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    await post(container, userId, "fogpage 連番メモ 006 (added between pages)");
    const edited = memos[2] as (typeof memos)[number];
    await editMemo({
      container,
      input: {
        userId,
        memoId: edited.id,
        body: "fogpage 連番メモ 003 edited between pages",
        expectedVersion: 0,
        actor: userActor(userId),
      },
    });
    const page2 = await find("fogpage", { limit: 2, cursor: page1.nextCursor });
    expect(page2.count).toBe(5);
    expect(page2.items).toHaveLength(2);
    const page3 = await find("fogpage", { limit: 2, cursor: page2.nextCursor });
    expect(page3.count).toBe(5);
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const seen = [...page1.items, ...page2.items, ...page3.items].map(
      (i) => i.id,
    );
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual(memos.map((m) => m.id).sort());
    const editedItem = [...page2.items, ...page3.items].find(
      (i) => i.id === edited.id,
    );
    expect(editedItem?.snippet).toContain("edited between pages");
    expect((await find("fogpage")).count).toBe(6);

    // A trashed row leaves its page without breaking the set.
    const fresh1 = await find("fogpage", { limit: 2 });
    await softDeleteMemo({
      container,
      input: { userId, memoId: memos[0]?.id as string },
    });
    const rest = [];
    let cursor = fresh1.nextCursor;
    while (cursor !== null) {
      const page = await find("fogpage", { limit: 2, cursor });
      rest.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(fresh1.count).toBe(6);
    expect([...fresh1.items, ...rest].map((i) => i.id)).not.toContain(
      memos[0]?.id,
    );
    expect([...fresh1.items, ...rest].length).toBeGreaterThanOrEqual(5);
  });

  it("(h2) honours limit 1 and 100, and an at-end cursor answers an empty page", async () => {
    const { container, userId, find } = await setUp();
    const memos = [];
    for (let n = 0; n < 3; n += 1)
      memos.push(await post(container, userId, `foglimit ${n}`));
    const one = await find("foglimit", { limit: 1 });
    expect(one.items).toHaveLength(1);
    expect(one.count).toBe(3);
    const hundred = await find("foglimit", { limit: 100 });
    expect(hundred.items).toHaveLength(3);
    expect(hundred.nextCursor).toBeNull();
    const two = await find("foglimit", { limit: 2 });
    const atEnd = encodeSearchCursor({
      ...decodeSearchCursor(two.nextCursor as never),
      offset: 3,
    });
    expect(await find("foglimit", { limit: 2, cursor: atEnd })).toEqual({
      items: [],
      count: 3,
      nextCursor: null,
    });
  });

  it("(j) refuses a cursor that is malformed, expired, or from another query", async () => {
    const { container, userId, find } = await setUp();
    for (let n = 0; n < 3; n += 1)
      await post(container, userId, `fogcursor ${n}`);
    const first = await find("fogcursor", { limit: 1 });
    const cursor = first.nextCursor as string;
    await expectCode(
      find("fogcursor", { limit: 1, cursor: "garbage" }),
      isBusinessRuleError,
      "INVALID_CURSOR",
    );
    const expired = encodeSearchCursor({
      ...decodeSearchCursor(cursor as never),
      expiresAt: Date.now() - 1,
    });
    await expectCode(
      find("fogcursor", { limit: 1, cursor: expired }),
      isBusinessRuleError,
      "INVALID_CURSOR",
    );
    await expectCode(
      find("fogother", { limit: 1, cursor }),
      isBusinessRuleError,
      "INVALID_CURSOR",
    );
    const t = await topic(container, userId);
    await expectCode(
      find("fogcursor", { limit: 1, cursor, topicId: t.id }),
      isBusinessRuleError,
      "INVALID_CURSOR",
    );

    // The lifetime is 30 minutes from the first page, judged by the index's clock.
    const verdicts = await inUserDataStorage(userId, (sql) => {
      const now = Date.now();
      const query = (offsetMs: number) => {
        try {
          createSearchIndex(sql, () => now + offsetMs).query(
            SearchQuery.create({
              keyword: "fogcursor",
              limit: 1,
              cursor: cursor as never,
            }),
          );
          return "ok";
        } catch (error) {
          return isBusinessRuleError(error) ? error.code : "other";
        }
      };
      return [
        query(SEARCH_SNAPSHOT_TTL_MS - 60_000),
        query(SEARCH_SNAPSHOT_TTL_MS + 60_000),
      ];
    });
    expect(verdicts).toEqual(["ok", "INVALID_CURSOR"]);
  });

  it("(h3) freezes at most 500 rows: the 501st match is not readable and count says 500", async () => {
    const { container, userId, find } = await setUp();
    const first = await post(container, userId, "fogcap 000 the oldest");
    for (let n = 1; n <= SEARCH_SNAPSHOT_LIMIT; n += 1) {
      await post(container, userId, `fogcap ${n}`);
    }
    const page = await find("fogcap", { limit: 100 });
    expect(page.count).toBe(SEARCH_SNAPSHOT_LIMIT);
    const ids = [...page.items.map((i) => i.id)];
    let cursor = page.nextCursor;
    while (cursor !== null) {
      const next = await find("fogcap", { limit: 100, cursor });
      ids.push(...next.items.map((i) => i.id));
      cursor = next.nextCursor;
    }
    expect(ids).toHaveLength(SEARCH_SNAPSHOT_LIMIT);
    expect(new Set(ids).size).toBe(SEARCH_SNAPSHOT_LIMIT);
    expect(ids).not.toContain(first.id);
  }, 60_000);
});

describe("search — index failure", () => {
  it("(q) reports a broken index as SearchIndexUnavailable, retryable", async () => {
    const { container, userId, find } = await setUp();
    await post(container, userId, "fogbroken");
    await inUserDataStorage(userId, (sql) => {
      sql.exec("DROP TABLE search_fts");
    });
    let caught: unknown = null;
    try {
      await find("fogbroken");
    } catch (error) {
      caught = error;
    }
    expect(isSystemError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("SEARCH_INDEX_UNAVAILABLE");
    expect((caught as { retryable: boolean }).retryable).toBe(true);
  });
});
