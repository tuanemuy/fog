import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { RpcResult } from "@repo/core/application/identity/contracts";
import type {
  SearchPage,
  SemanticCommand,
  SemanticCommitResult,
} from "@repo/core/application/search/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { UserDataDurableObject } from "../UserDataDurableObject";

type TestEnv = {
  USER_DATA: DurableObjectNamespace<UserDataDurableObject>;
};

const bindings = env as unknown as TestEnv;

afterEach(() => reset());

function object(name: string) {
  return bindings.USER_DATA.getByName(`search-${name}`);
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function commit(
  stub: DurableObjectStub<UserDataDurableObject>,
  command: SemanticCommand,
): Promise<SemanticCommitResult> {
  return value(await stub.commit(command));
}

async function query(
  stub: DurableObjectStub<UserDataDurableObject>,
  keyword: string,
  options: { topicId?: string; limit?: number; cursor?: string } = {},
): Promise<SearchPage> {
  return value(await stub.search({ keyword, ...options })) as SearchPage;
}

describe("User Data semantic search contract", () => {
  it("commits typed memo/document lifecycle, revisions, sources, and digest idempotency", async () => {
    const stub = object("lifecycle");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "search-lifecycle",
        now: 1,
      }),
    );
    const createMemo = {
      version: 1,
      operationId: "memo-create",
      type: "create-memo",
      memo: {
        id: "memo-1",
        body: "古い設計メモ",
        timestamp: 2,
      },
    } as const satisfies SemanticCommand;
    expect(await commit(stub, createMemo)).toEqual({
      operationId: "memo-create",
      replayed: false,
    });
    expect(await commit(stub, createMemo)).toEqual({
      operationId: "memo-create",
      replayed: true,
    });
    expect(
      await stub.commit({
        ...createMemo,
        memo: { ...createMemo.memo, body: "異なる本文" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT", kind: "conflict" },
    });
    await commit(stub, {
      version: 1,
      operationId: "topic-create",
      type: "create-topic",
      topic: {
        id: "topic-1",
        name: "設計",
        sourceMemoId: "memo-1",
        timestamp: 3,
      },
    });
    await commit(stub, {
      version: 1,
      operationId: "document-create",
      type: "create-document",
      document: {
        id: "document-1",
        title: "設計資料",
        body: "古い設計を詳しく説明する",
        timestamp: 4,
        topicId: "topic-1",
        sourceMemoIds: ["memo-1"],
      },
    });

    const initial = await query(stub, "古い");
    expect(initial.items).toEqual([
      {
        type: "document",
        id: "document-1",
        title: "設計資料",
        snippet: "<mark>古い</mark>設計を詳しく説明する",
        timestamp: new Date(4).toISOString(),
        topic: { id: "topic-1", name: "設計", archived: false },
        sourceMemoIds: ["memo-1"],
      },
      {
        type: "memo",
        id: "memo-1",
        snippet: "<mark>古い</mark>設計メモ",
        timestamp: new Date(2).toISOString(),
        sourceOfDocumentIds: ["document-1"],
      },
    ]);

    await commit(stub, {
      version: 1,
      operationId: "memo-update",
      type: "update-memo",
      memo: { id: "memo-1", body: "新しい復旧メモ", timestamp: 5 },
    });
    expect((await query(stub, "古い")).items.map((item) => item.id)).toEqual([
      "document-1",
    ]);
    expect((await query(stub, "新しい")).items).toHaveLength(1);

    await commit(stub, {
      version: 1,
      operationId: "memo-trash",
      type: "trash-memo",
      memoId: "memo-1",
      trashedAt: 6,
    });
    const withoutSource = await query(stub, "古い");
    expect(withoutSource.items[0]).toMatchObject({
      type: "document",
      sourceMemoIds: [],
    });
    await commit(stub, {
      version: 1,
      operationId: "memo-restore",
      type: "restore-memo",
      memo: { id: "memo-1", body: "新しい復旧メモ", timestamp: 7 },
    });
    expect((await query(stub, "新しい")).items).toHaveLength(1);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ version: number }>(
            `SELECT version FROM content_revisions
             WHERE content_id = 'memo-1' ORDER BY version`,
          )
          .toArray(),
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    });
    await commit(stub, {
      version: 1,
      operationId: "memo-remove",
      type: "remove-memo",
      memoId: "memo-1",
      removedAt: 8,
    });
    expect((await query(stub, "古い")).items[0]).toMatchObject({
      type: "document",
      sourceMemoIds: [],
    });
  });

  it("uses topic authority for archive, trash, restore, and topic source scope", async () => {
    const stub = object("topic");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "search-topic",
        now: 1,
      }),
    );
    await commit(stub, {
      operationId: "memo",
      type: "create-memo",
      memo: { id: "memo", body: "共有検索語", timestamp: 2 },
    });
    await commit(stub, {
      operationId: "topic",
      type: "create-topic",
      topic: {
        id: "topic",
        name: "Topic",
        sourceMemoId: "memo",
        timestamp: 3,
      },
    });
    await commit(stub, {
      operationId: "document",
      type: "create-document",
      document: {
        id: "document",
        title: "Document",
        body: "共有検索語",
        timestamp: 4,
        topicId: "topic",
        sourceMemoIds: ["memo"],
      },
    });
    expect(
      (await query(stub, "共有検索語", { topicId: "topic" })).items
        .map((item) => item.type)
        .sort(),
    ).toEqual(["document", "memo"]);
    await commit(stub, {
      operationId: "archive",
      type: "set-topic-archived",
      topicId: "topic",
      archivedAt: 5,
      updatedAt: 5,
    });
    expect(
      (await query(stub, "共有検索語")).items.find(
        (item) => item.type === "document",
      ),
    ).toMatchObject({
      type: "document",
      topic: { archived: true },
    });
    await commit(stub, {
      operationId: "trash",
      type: "trash-topic",
      topicId: "topic",
      trashedAt: 6,
    });
    expect(
      (await query(stub, "共有検索語")).items.map((item) => item.type),
    ).toEqual(["memo"]);
    expect(
      await stub.search({ keyword: "共有検索語", topicId: "topic" }),
    ).toMatchObject({
      ok: false,
      error: { code: "TOPIC_NOT_FOUND", kind: "not-found" },
    });
    await commit(stub, {
      operationId: "restore",
      type: "restore-topic",
      topicId: "topic",
      restoredAt: 7,
    });
    expect((await query(stub, "共有検索語")).items).toHaveLength(2);
  });

  it("returns original NFKC snippets and typed validation errors", async () => {
    const stub = object("normalization");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "search-normalization",
        now: 1,
      }),
    );
    await commit(stub, {
      operationId: "memo",
      type: "create-memo",
      memo: { id: "memo", body: "原文①と設計", timestamp: 2 },
    });
    expect((await query(stub, "1")).items[0]).toMatchObject({
      type: "memo",
      snippet: "原文<mark>①</mark>と設計",
    });
    expect((await query(stub, "設")).items[0]).toMatchObject({
      type: "memo",
      snippet: "原文①と<mark>設</mark>計",
    });
    expect(await stub.search({ keyword: "   " })).toMatchObject({
      ok: false,
      error: { code: "SEARCH_EMPTY_KEYWORD", kind: "validation" },
    });
    expect(await stub.search({ keyword: "a".repeat(51) })).toMatchObject({
      ok: false,
      error: { code: "SEARCH_KEYWORD_TOO_LONG", kind: "validation" },
    });
    expect(value(await stub.search({ keyword: "a".repeat(50) })).items).toEqual(
      [],
    );
    expect(value(await stub.search({ keyword: '"*() OR -' })).items).toEqual(
      [],
    );
    expect(value(await stub.search({ keyword: "見つからない" })).items).toEqual(
      [],
    );
    expect(
      await stub.search({ keyword: "x", limit: Number.NaN }),
    ).toMatchObject({
      ok: false,
      error: { code: "SEARCH_INVALID_PAGINATION", kind: "validation" },
    });
  });

  it("rolls back a rejected main write including its idempotency record", async () => {
    const stub = object("main-rollback");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "search-main-rollback",
        now: 1,
      }),
    );
    await commit(stub, {
      operationId: "topic",
      type: "create-topic",
      topic: { id: "topic", name: "Topic", timestamp: 2 },
    });
    const operationId = "document-create";
    expect(
      await stub.commit({
        operationId,
        type: "create-document",
        document: {
          id: "document",
          title: "Document",
          body: "rollback target",
          topicId: "topic",
          sourceMemoIds: ["missing"],
          timestamp: 3,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "SOURCE_MEMO_NOT_FOUND", kind: "not-found" },
    });
    await commit(stub, {
      operationId: "memo",
      type: "create-memo",
      memo: { id: "memo", body: "source", timestamp: 4 },
    });
    await commit(stub, {
      operationId,
      type: "create-document",
      document: {
        id: "document",
        title: "Document",
        body: "rollback target",
        topicId: "topic",
        sourceMemoIds: ["memo"],
        timestamp: 3,
      },
    });
    expect((await query(stub, "rollback target")).items).toHaveLength(1);
  });

  it("uses a stable snapshot cursor across intervening mutations", async () => {
    const stub = object("cursor");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "search-cursor",
        now: 1,
      }),
    );
    for (const [index, id] of ["a", "b", "c"].entries()) {
      await commit(stub, {
        operationId: `create-${id}`,
        type: "create-memo",
        memo: { id, body: "共通検索語", timestamp: index + 2 },
      });
    }
    const first = await query(stub, "共通検索語", { limit: 2 });
    expect(first.totalCount).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    await commit(stub, {
      operationId: "create-new",
      type: "create-memo",
      memo: { id: "new", body: "共通検索語", timestamp: 100 },
    });
    const second = await query(stub, "共通検索語", {
      limit: 2,
      ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
    });
    expect([
      ...first.items.map((item) => item.id),
      ...second.items.map((item) => item.id),
    ]).toEqual(["c", "b", "a"]);
    expect(second.totalCount).toBe(3);
    expect(
      await stub.search({
        keyword: "別の検索語",
        ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "SEARCH_INVALID_CURSOR", kind: "validation" },
    });
  });

  it("runs the bounded internal retention executor to completion", async () => {
    const stub = object("retention");
    const expiredAt = Date.now() - 31 * 86_400_000;
    value(
      await stub.initialize({
        operationId: "init",
        userId: "search-retention",
        now: expiredAt - 1,
      }),
    );
    await commit(stub, {
      operationId: "create",
      type: "create-memo",
      memo: { id: "expired", body: "期限切れメモ", timestamp: expiredAt - 1 },
    });
    await commit(stub, {
      operationId: "trash",
      type: "trash-memo",
      memoId: "expired",
      trashedAt: expiredAt,
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      await stub.commit({
        operationId: "restore",
        type: "restore-memo",
        memo: { id: "expired", body: "期限切れメモ", timestamp: Date.now() },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONTENT_NOT_FOUND", kind: "not-found" },
    });
  });
});
