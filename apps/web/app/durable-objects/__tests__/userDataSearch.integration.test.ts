import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Fts5SearchAdapter } from "@repo/core/adapters/cloudflare/user-data/searchIndex";
import type { RpcResult } from "@repo/core/application/identity/contracts";
import {
  AiSearchConsumer,
  UiSearchConsumer,
} from "@repo/core/application/search/consumers";
import type {
  SearchPage,
  SemanticCommitResult,
  SemanticRpcCommand,
} from "@repo/core/application/search/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalUserDataDurableObject as UserDataDurableObject } from "../../testing/LocalUserDataDurableObject";

type TestEnv = {
  USER_DATA: DurableObjectNamespace<UserDataDurableObject>;
};

type OptionalExpected<T> = T extends unknown
  ? Omit<T, "expectedVersion" | "topicExpectedVersion"> & {
      expectedVersion?: number;
      topicExpectedVersion?: number;
    }
  : never;
type TestSemanticCommand = OptionalExpected<SemanticRpcCommand>;

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
  command: TestSemanticCommand,
): Promise<SemanticCommitResult> {
  let topicExpectedVersion = command.topicExpectedVersion;
  const restoreDocumentId =
    command.type === "restore-document" ? command.documentId : undefined;
  if (
    (command.type === "create-document" ||
      command.type === "restore-document") &&
    topicExpectedVersion === undefined
  ) {
    await runInDurableObject(stub, (_instance, state) => {
      let topicId =
        command.type === "create-document"
          ? command.document.topicId
          : command.destinationTopicId;
      if (topicId === undefined) {
        if (restoreDocumentId === undefined) {
          throw new Error("TEST_RESTORE_DOCUMENT_ID_REQUIRED");
        }
        topicId = state.storage.sql
          .exec<{ topic_id: string }>(
            "SELECT topic_id FROM content WHERE id = ?",
            restoreDocumentId,
          )
          .one().topic_id;
      }
      topicExpectedVersion = state.storage.sql
        .exec<{ version: number }>(
          "SELECT version FROM topics WHERE id = ?",
          topicId,
        )
        .one().version;
    });
  }
  if (
    command.type === "create-memo" ||
    command.type === "create-document" ||
    command.type === "create-topic" ||
    command.expectedVersion !== undefined
  ) {
    return value(
      await stub.commit({
        ...command,
        ...(topicExpectedVersion === undefined ? {} : { topicExpectedVersion }),
      } as SemanticRpcCommand),
    );
  }
  const topicMutation =
    command.type === "set-topic-archived" ||
    command.type === "trash-topic" ||
    command.type === "restore-topic" ||
    command.type === "remove-topic";
  const id =
    "memoId" in command
      ? command.memoId
      : "documentId" in command
        ? command.documentId
        : "topicId" in command
          ? command.topicId
          : command.type === "update-memo"
            ? command.memo.id
            : command.document.id;
  let expectedVersion = -1;
  await runInDurableObject(stub, (_instance, state) => {
    expectedVersion = (
      topicMutation
        ? state.storage.sql
            .exec<{ version: number }>(
              "SELECT version FROM topics WHERE id = ?",
              id,
            )
            .one()
        : state.storage.sql
            .exec<{ version: number }>(
              "SELECT version FROM content WHERE id = ?",
              id,
            )
            .one()
    ).version;
  });
  return value(
    await stub.commit({
      ...command,
      expectedVersion,
      ...(topicExpectedVersion === undefined ? {} : { topicExpectedVersion }),
    } as SemanticRpcCommand),
  );
}

async function query(
  stub: DurableObjectStub<UserDataDurableObject>,
  keyword: string,
  options: { topicId?: string; limit?: number; cursor?: string } = {},
): Promise<SearchPage> {
  return value(
    await stub.search({ version: 1, keyword, ...options }),
  ) as SearchPage;
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
    } as const satisfies SemanticRpcCommand;
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
      memoId: "memo-1",
      restoredAt: 7,
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
      ).toEqual([{ version: 1 }, { version: 2 }]);
    });
    await commit(stub, {
      version: 1,
      operationId: "memo-trash-before-remove",
      type: "trash-memo",
      memoId: "memo-1",
      trashedAt: 8,
    });
    await commit(stub, {
      version: 1,
      operationId: "memo-remove",
      type: "remove-memo",
      memoId: "memo-1",
      removedAt: 9,
    });
    expect((await query(stub, "古い")).items[0]).toMatchObject({
      type: "document",
      sourceMemoIds: [],
    });
  });

  it("uses a trusted clock for semantic idempotency retention", async () => {
    const stub = object("trusted-idempotency-clock");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "trusted-idempotency-clock",
        now: 1,
      }),
    );
    await commit(stub, {
      version: 1,
      operationId: "stable-operation",
      type: "create-memo",
      memo: { id: "stable", body: "stable", timestamp: 1 },
    });
    await commit(stub, {
      version: 1,
      operationId: "future-business-time",
      type: "create-memo",
      memo: {
        id: "future",
        body: "future",
        timestamp: 8_000_000_000_000_000,
      },
    });
    expect(
      await stub.commit({
        version: 1,
        operationId: "stable-operation",
        type: "create-memo",
        memo: { id: "stable", body: "different", timestamp: 1 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT", kind: "conflict" },
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
      version: 1,
      operationId: "memo",
      type: "create-memo",
      memo: { id: "memo", body: "共有検索語", timestamp: 2 },
    });
    await commit(stub, {
      version: 1,
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
      version: 1,
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
    await commit(stub, {
      version: 1,
      operationId: "document-independent",
      type: "create-document",
      document: {
        id: "document-independent",
        title: "Independent",
        body: "共有検索語",
        timestamp: 4,
        topicId: "topic",
        sourceMemoIds: ["memo"],
      },
    });
    await commit(stub, {
      version: 1,
      operationId: "document-independent-trash",
      type: "trash-document",
      documentId: "document-independent",
      trashedAt: 5,
    });
    expect(
      (await query(stub, "共有検索語", { topicId: "topic" })).items
        .map((item) => item.type)
        .sort(),
    ).toEqual(["document", "memo"]);
    await commit(stub, {
      version: 1,
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
      version: 1,
      operationId: "trash",
      type: "trash-topic",
      topicId: "topic",
      trashedAt: 6,
    });
    expect(
      (await query(stub, "共有検索語")).items.map((item) => item.type),
    ).toEqual(["memo"]);
    expect((await query(stub, "共有検索語")).items[0]).toMatchObject({
      type: "memo",
      sourceOfDocumentIds: [],
    });
    expect(
      await stub.search({
        version: 1,
        keyword: "共有検索語",
        topicId: "topic",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "TOPIC_NOT_FOUND", kind: "not-found" },
    });
    await commit(stub, {
      version: 1,
      operationId: "restore",
      type: "restore-topic",
      topicId: "topic",
      restoredAt: 7,
    });
    expect((await query(stub, "共有検索語")).items).toHaveLength(2);
    expect(
      await stub.commit({
        version: 1,
        operationId: "stale-document-after-topic-restore",
        type: "update-document",
        expectedVersion: 1,
        changeReason: "stale edit",
        document: {
          id: "document",
          title: "Stale",
          body: "must not overwrite",
          topicId: "topic",
          sourceMemoIds: ["memo"],
          timestamp: 8,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONTENT_VERSION_CONFLICT", kind: "conflict" },
    });
    expect(
      await stub.commit({
        version: 1,
        operationId: "remove-active-topic",
        type: "remove-topic",
        topicId: "topic",
        removedAt: 8,
        expectedVersion: 5,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "TOPIC_NOT_FOUND", kind: "not-found" },
    });
    await commit(stub, {
      version: 1,
      operationId: "destination-topic",
      type: "create-topic",
      topic: { id: "destination", name: "Destination", timestamp: 8 },
    });
    await commit(stub, {
      version: 1,
      operationId: "trash-again",
      type: "trash-topic",
      topicId: "topic",
      trashedAt: 9,
    });
    await commit(stub, {
      version: 1,
      operationId: "remove-topic",
      type: "remove-topic",
      topicId: "topic",
      removedAt: 10,
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ topic_id: string | null; trashed_at: number | null }>(
            `SELECT topic_id, trashed_at FROM content
             WHERE id = 'document-independent'`,
          )
          .one(),
      ).toEqual({ topic_id: null, trashed_at: 5 });
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM content WHERE id = 'document'",
          )
          .one().count,
      ).toBe(0);
    });
    expect(
      await stub.commit({
        version: 1,
        operationId: "restore-independent-without-destination",
        type: "restore-document",
        documentId: "document-independent",
        restoredAt: 11,
        expectedVersion: 1,
        topicExpectedVersion: 0,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "DOCUMENT_TOPIC_REQUIRED", kind: "conflict" },
    });
    await commit(stub, {
      version: 1,
      operationId: "restore-independent-to-destination",
      type: "restore-document",
      documentId: "document-independent",
      destinationTopicId: "destination",
      restoredAt: 11,
    });
    expect((await query(stub, "共有検索語")).items).toContainEqual(
      expect.objectContaining({
        type: "document",
        id: "document-independent",
        topic: expect.objectContaining({ id: "destination" }),
      }),
    );
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
      version: 1,
      operationId: "memo",
      type: "create-memo",
      memo: { id: "memo", body: "原文①と設計 カ\u3099", timestamp: 2 },
    });
    expect((await query(stub, "1")).items[0]).toMatchObject({
      type: "memo",
      snippet: "原文<mark>①</mark>と設計 カ\u3099",
    });
    expect((await query(stub, "設")).items[0]).toMatchObject({
      type: "memo",
      snippet: "原文①と<mark>設</mark>計 カ\u3099",
    });
    expect((await query(stub, "ガ")).items[0]).toMatchObject({
      type: "memo",
      snippet: "原文①と設計 <mark>カ\u3099</mark>",
    });
    expect(await stub.search({ version: 1, keyword: "   " })).toMatchObject({
      ok: false,
      error: { code: "SEARCH_EMPTY_KEYWORD", kind: "validation" },
    });
    expect(
      await stub.search({ version: 1, keyword: "a".repeat(51) }),
    ).toMatchObject({
      ok: false,
      error: { code: "SEARCH_KEYWORD_TOO_LONG", kind: "validation" },
    });
    expect(
      value(await stub.search({ version: 1, keyword: "a".repeat(50) })).items,
    ).toEqual([]);
    expect(
      value(
        await stub.search({
          version: 1,
          keyword: `${"界".repeat(16)}ab`,
        }),
      ).items,
    ).toEqual([]);
    expect(
      await stub.search({
        version: 1,
        keyword: `${"界".repeat(16)}abc`,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "SEARCH_KEYWORD_TOO_LONG", kind: "validation" },
    });
    expect(
      value(await stub.search({ version: 1, keyword: '"*() OR -' })).items,
    ).toEqual([]);
    expect(
      value(await stub.search({ version: 1, keyword: "見つからない" })).items,
    ).toEqual([]);
    expect(
      await stub.search({ version: 1, keyword: "x", limit: Number.NaN }),
    ).toMatchObject({
      ok: false,
      error: { code: "SEARCH_INVALID_PAGINATION", kind: "validation" },
    });
    expect(
      await stub.commit({
        version: 1,
        operationId: "empty-memo",
        type: "create-memo",
        memo: { id: "empty", body: "  ", timestamp: 3 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "EMPTY_MEMO_BODY", kind: "validation" },
    });
  });

  it("prepares topic and revision value objects before opening a transaction", async () => {
    const stub = object("prepared-domain-values");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "prepared-domain-values",
        now: 1,
      }),
    );
    for (const [name, code] of [
      ["   ", "EMPTY_TOPIC_NAME"],
      ["line one\nline two", "TOPIC_NAME_MULTILINE"],
      ["界".repeat(101), "TOPIC_NAME_TOO_LONG"],
    ] as const) {
      expect(
        await stub.commit({
          version: 1,
          operationId: `topic-${code}`,
          type: "create-topic",
          topic: { id: `topic-${code}`, name, timestamp: 2 },
        }),
      ).toMatchObject({
        ok: false,
        error: { code, kind: "validation" },
      });
    }
    await commit(stub, {
      version: 1,
      operationId: "topic",
      type: "create-topic",
      topic: { id: "topic", name: "Topic", timestamp: 3 },
    });
    await commit(stub, {
      version: 1,
      operationId: "document",
      type: "create-document",
      document: {
        id: "document",
        title: "Document",
        body: "",
        topicId: "topic",
        sourceMemoIds: [],
        timestamp: 4,
      },
    });
    for (const [changeReason, code] of [
      ["   ", "EMPTY_CHANGE_REASON"],
      ["line one\nline two", "CHANGE_REASON_MULTILINE"],
      ["界".repeat(201), "CHANGE_REASON_TOO_LONG"],
    ] as const) {
      expect(
        await stub.commit({
          version: 1,
          operationId: `update-${code}`,
          type: "update-document",
          expectedVersion: 1,
          changeReason,
          document: {
            id: "document",
            title: "Document",
            body: "changed",
            topicId: "topic",
            sourceMemoIds: [],
            timestamp: 5,
          },
        }),
      ).toMatchObject({
        ok: false,
        error: { code, kind: "validation" },
      });
    }
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
      version: 1,
      operationId: "topic",
      type: "create-topic",
      topic: { id: "topic", name: "Topic", timestamp: 2 },
    });
    expect(
      await stub.commit({
        version: 1,
        operationId: "empty-title",
        type: "create-document",
        topicExpectedVersion: 0,
        document: {
          id: "empty-title",
          title: " ",
          body: "body",
          topicId: "topic",
          sourceMemoIds: [],
          timestamp: 3,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "EMPTY_DOCUMENT_TITLE", kind: "validation" },
    });
    const operationId = "document-create";
    expect(
      await stub.commit({
        version: 1,
        operationId,
        type: "create-document",
        topicExpectedVersion: 0,
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
      version: 1,
      operationId: "memo",
      type: "create-memo",
      memo: { id: "memo", body: "source", timestamp: 4 },
    });
    await commit(stub, {
      version: 1,
      operationId,
      type: "create-document",
      topicExpectedVersion: 0,
      document: {
        id: "document",
        title: "Document",
        body: "rollback target",
        topicId: "topic",
        sourceMemoIds: Array.from({ length: 101 }, () => "memo"),
        timestamp: 3,
      },
    });
    expect((await query(stub, "rollback target")).items[0]).toMatchObject({
      sourceMemoIds: ["memo"],
    });
    expect(
      await commit(stub, {
        version: 1,
        operationId,
        type: "create-document",
        topicExpectedVersion: 0,
        document: {
          id: "document",
          title: "Document",
          body: "rollback target",
          topicId: "topic",
          sourceMemoIds: ["memo"],
          timestamp: 3,
        },
      }),
    ).toEqual({ operationId, replayed: true });
  });

  it("rolls back main, FTS, and idempotency after a projection write fails", async () => {
    for (const point of [
      "after-entry-insert",
      "after-fts-insert",
      "after-fts-delete",
      "after-entry-delete",
    ] as const) {
      const stub = object(`projection-${point}`);
      value(
        await stub.initialize({
          operationId: "init",
          userId: `projection-${point}`,
          now: 1,
        }),
      );
      const deletePath =
        point === "after-fts-delete" || point === "after-entry-delete";
      if (deletePath) {
        await commit(stub, {
          version: 1,
          operationId: "seed",
          type: "create-memo",
          memo: { id: "memo", body: "original projection", timestamp: 2 },
        });
      }
      const operationId = deletePath ? "update" : "create";
      const result = deletePath
        ? await stub.commitWithProjectionFailure(
            {
              version: 1,
              operationId,
              type: "update-memo",
              memo: { id: "memo", body: "changed projection", timestamp: 3 },
              expectedVersion: 0,
            },
            point,
          )
        : await stub.commitWithProjectionFailure(
            {
              version: 1,
              operationId,
              type: "create-memo",
              memo: { id: "memo", body: "projection rollback", timestamp: 2 },
            },
            point,
          );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "infrastructure" },
      });
      await runInDurableObject(stub, (_instance, state) => {
        expect(
          state.storage.sql
            .exec<{ body: string; version: number }>(
              "SELECT body, version FROM content WHERE id = 'memo'",
            )
            .toArray(),
        ).toEqual(
          deletePath ? [{ body: "original projection", version: 0 }] : [],
        );
        expect(
          state.storage.sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count FROM search_entries
               WHERE entity_id = 'memo'`,
            )
            .one().count,
        ).toBe(deletePath ? 1 : 0);
        expect(
          state.storage.sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count FROM search_fts
               WHERE search_fts MATCH ?`,
              deletePath ? '"original projection"' : '"projection rollback"',
            )
            .one().count,
        ).toBe(deletePath ? 1 : 0);
        expect(
          state.storage.sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count FROM idempotency
               WHERE namespace = 'semantic' AND operation_id = ?`,
              operationId,
            )
            .one().count,
        ).toBe(0);
      });
    }
  });

  it("rejects an async transaction callback and rolls back its writes", async () => {
    const stub = object("async-transaction");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "async-transaction",
        now: 1,
      }),
    );
    expect(
      await stub.commitWithAsyncCallback({
        version: 1,
        operationId: "async-create",
        type: "create-memo",
        memo: { id: "memo", body: "must rollback", timestamp: 2 },
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: "infrastructure" },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM content
             WHERE id = 'memo'`,
          )
          .one().count,
      ).toBe(0);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM idempotency
             WHERE namespace = 'semantic' AND operation_id = 'async-create'`,
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("requires an exhaustive versioned RPC schema and rejects legacy input", async () => {
    const stub = object("rpc-schema");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "search-rpc-schema",
        now: 1,
      }),
    );
    const raw = stub as unknown as {
      commit(command: unknown): Promise<RpcResult<SemanticCommitResult>>;
      search(query: unknown): Promise<RpcResult<SearchPage>>;
    };
    for (const command of [
      {
        operationId: "missing-version",
        type: "create-memo",
        memo: { id: "memo", body: "body", timestamp: 2 },
      },
      {
        version: 1,
        operationId: "unknown",
        type: "unknown-command",
      },
      {
        version: 1,
        operationId: "malformed",
        type: "create-memo",
        memo: { id: "memo", body: 1, timestamp: 2 },
      },
      {
        version: 1,
        operationId: "missing-expected-version",
        type: "update-memo",
        memo: { id: "memo", body: "body", timestamp: 2 },
      },
      {
        version: 1,
        operationId: "legacy",
        type: ["upsert", "content"].join("-"),
        entry: {},
      },
    ]) {
      expect(await raw.commit(command)).toMatchObject({
        ok: false,
        error: { code: "SEMANTIC_COMMAND_INVALID", kind: "validation" },
      });
    }
    expect(await raw.search({ keyword: "body" })).toMatchObject({
      ok: false,
      error: { code: "SEARCH_QUERY_INVALID", kind: "validation" },
    });
    expect(
      await raw.search({ version: 1, text: "body", offset: 0 }),
    ).toMatchObject({
      ok: false,
      error: { code: "SEARCH_QUERY_INVALID", kind: "validation" },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM idempotency
             WHERE namespace = 'semantic'`,
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("uses topic OCC for document create and restore transitions", async () => {
    const stub = object("document-topic-occ");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "document-topic-occ",
        now: 1,
      }),
    );
    await commit(stub, {
      version: 1,
      operationId: "topic",
      type: "create-topic",
      topic: { id: "topic", name: "Topic", timestamp: 2 },
    });
    await commit(stub, {
      version: 1,
      operationId: "document",
      type: "create-document",
      topicExpectedVersion: 0,
      document: {
        id: "document",
        title: "Document",
        body: "topic OCC",
        timestamp: 3,
        topicId: "topic",
        sourceMemoIds: [],
      },
    });
    expect(
      await stub.commit({
        version: 1,
        operationId: "stale-document",
        type: "create-document",
        topicExpectedVersion: 0,
        document: {
          id: "stale-document",
          title: "Stale",
          body: "must rollback",
          timestamp: 4,
          topicId: "topic",
          sourceMemoIds: [],
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "TOPIC_VERSION_CONFLICT", kind: "conflict" },
    });
    await commit(stub, {
      version: 1,
      operationId: "trash-document",
      type: "trash-document",
      documentId: "document",
      trashedAt: 5,
      expectedVersion: 0,
    });
    await commit(stub, {
      version: 1,
      operationId: "trash-topic",
      type: "trash-topic",
      topicId: "topic",
      trashedAt: 6,
      expectedVersion: 1,
    });
    await commit(stub, {
      version: 1,
      operationId: "remove-topic",
      type: "remove-topic",
      topicId: "topic",
      removedAt: 7,
      expectedVersion: 2,
    });
    await commit(stub, {
      version: 1,
      operationId: "destination",
      type: "create-topic",
      topic: { id: "destination", name: "Destination", timestamp: 8 },
    });
    await commit(stub, {
      version: 1,
      operationId: "restore-document",
      type: "restore-document",
      documentId: "document",
      destinationTopicId: "destination",
      restoredAt: 9,
      expectedVersion: 1,
      topicExpectedVersion: 0,
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{
            topic_id: string;
            version: number;
            trashed_at: number | null;
          }>(
            `SELECT topic_id, version, trashed_at FROM content
             WHERE id = 'document'`,
          )
          .one(),
      ).toEqual({
        topic_id: "destination",
        version: 3,
        trashed_at: null,
      });
      expect(
        state.storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM topics WHERE id = 'destination'",
          )
          .one().version,
      ).toBe(1);
    });
  });

  it("rejects a destination for restoreAlone and increments its version once", async () => {
    const stub = object("document-restore-alone");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "document-restore-alone",
        now: 1,
      }),
    );
    await commit(stub, {
      version: 1,
      operationId: "topic",
      type: "create-topic",
      topic: { id: "topic", name: "Topic", timestamp: 2 },
    });
    await commit(stub, {
      version: 1,
      operationId: "document",
      type: "create-document",
      topicExpectedVersion: 0,
      document: {
        id: "document",
        title: "Document",
        body: "restore alone",
        timestamp: 3,
        topicId: "topic",
        sourceMemoIds: [],
      },
    });
    await commit(stub, {
      version: 1,
      operationId: "trash-document",
      type: "trash-document",
      documentId: "document",
      trashedAt: 4,
      expectedVersion: 0,
    });

    expect(
      await stub.commit({
        version: 1,
        operationId: "invalid-same-destination",
        type: "restore-document",
        documentId: "document",
        destinationTopicId: "topic",
        restoredAt: 5,
        expectedVersion: 1,
        topicExpectedVersion: 1,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "DOCUMENT_TOPIC_REQUIRED", kind: "conflict" },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ trashed_at: number | null; version: number }>(
            "SELECT trashed_at, version FROM content WHERE id = 'document'",
          )
          .one(),
      ).toEqual({ trashed_at: 4, version: 1 });
      expect(
        state.storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM topics WHERE id = 'topic'",
          )
          .one().version,
      ).toBe(1);
    });

    await commit(stub, {
      version: 1,
      operationId: "restore-alone",
      type: "restore-document",
      documentId: "document",
      restoredAt: 6,
      expectedVersion: 1,
      topicExpectedVersion: 1,
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{
            topic_id: string;
            trashed_at: number | null;
            version: number;
          }>(
            `SELECT topic_id, trashed_at, version FROM content
             WHERE id = 'document'`,
          )
          .one(),
      ).toEqual({
        topic_id: "topic",
        trashed_at: null,
        version: 2,
      });
      expect(
        state.storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM topics WHERE id = 'topic'",
          )
          .one().version,
      ).toBe(2);
    });
  });

  it("covers document update, trash, restore, and trash-only hard delete", async () => {
    const stub = object("document-lifecycle");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "search-document-lifecycle",
        now: 1,
      }),
    );
    await commit(stub, {
      version: 1,
      operationId: "topic",
      type: "create-topic",
      topic: { id: "topic", name: "Topic", timestamp: 2 },
    });
    await commit(stub, {
      version: 1,
      operationId: "create",
      type: "create-document",
      document: {
        id: "document",
        title: "Original",
        body: "original lifecycle token",
        timestamp: 3,
        topicId: "topic",
        sourceMemoIds: [],
      },
    });
    expect(
      await stub.commit({
        version: 1,
        operationId: "remove-active",
        type: "remove-document",
        documentId: "document",
        removedAt: 4,
        expectedVersion: 0,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONTENT_NOT_FOUND", kind: "conflict" },
    });
    await commit(stub, {
      version: 1,
      operationId: "update",
      type: "update-document",
      changeReason: "document lifecycle edit",
      document: {
        id: "document",
        title: "Updated",
        body: "updated lifecycle token",
        timestamp: 5,
        topicId: "topic",
        sourceMemoIds: [],
      },
    });
    expect((await query(stub, "original lifecycle token")).items).toEqual([]);
    await commit(stub, {
      version: 1,
      operationId: "trash",
      type: "trash-document",
      documentId: "document",
      trashedAt: 6,
    });
    expect((await query(stub, "updated lifecycle token")).items).toEqual([]);
    await commit(stub, {
      version: 1,
      operationId: "restore",
      type: "restore-document",
      documentId: "document",
      restoredAt: 7,
    });
    expect((await query(stub, "updated lifecycle token")).items).toHaveLength(
      1,
    );
    await commit(stub, {
      version: 1,
      operationId: "trash-final",
      type: "trash-document",
      documentId: "document",
      trashedAt: 8,
    });
    await commit(stub, {
      version: 1,
      operationId: "remove",
      type: "remove-document",
      documentId: "document",
      removedAt: 9,
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM content_revisions
             WHERE content_id = 'document'`,
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("respects the 100-bind ceiling, deterministic ties, and snapshot quota", async () => {
    const stub = object("search-limits");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "search-limits",
        now: 1,
      }),
    );
    for (let index = 0; index < 100; index += 1) {
      const id = `bulk-${index.toString().padStart(3, "0")}`;
      await commit(stub, {
        version: 1,
        operationId: `create-${id}`,
        type: "create-memo",
        memo: { id, body: "bulk-boundary-token", timestamp: index + 2 },
      });
    }
    const first = await query(stub, "bulk-boundary-token", { limit: 20 });
    expect(first.totalCount).toBe(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await query(stub, "bulk-boundary-token", {
      limit: 20,
      ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
    });
    expect(second.items).toHaveLength(20);
    for (let iteration = 0; iteration < 9; iteration += 1) {
      expect(
        (await query(stub, "bulk-boundary-token", { limit: 1 })).nextCursor,
      ).not.toBeNull();
    }
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM search_snapshots",
          )
          .one().count,
      ).toBeLessThanOrEqual(8);
    });

    await commit(stub, {
      version: 1,
      operationId: "tie-topic",
      type: "create-topic",
      topic: { id: "tie-topic", name: "Tie", timestamp: 200 },
    });
    for (const id of ["tie-b", "tie-a"]) {
      await commit(stub, {
        version: 1,
        operationId: `create-${id}`,
        type: "create-memo",
        memo: { id, body: "xy", timestamp: 201 },
      });
    }
    await commit(stub, {
      version: 1,
      operationId: "tie-document",
      type: "create-document",
      document: {
        id: "tie-document",
        title: "Tie",
        body: "xy",
        timestamp: 201,
        topicId: "tie-topic",
        sourceMemoIds: [],
      },
    });
    expect((await query(stub, "xy")).items.map(({ id }) => id)).toEqual([
      "tie-document",
      "tie-a",
      "tie-b",
    ]);
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
        version: 1,
        operationId: `create-${id}`,
        type: "create-memo",
        memo: { id, body: "共通検索語", timestamp: index + 2 },
      });
    }
    const first = await query(stub, "共通検索語", { limit: 2 });
    expect(first.totalCount).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    await commit(stub, {
      version: 1,
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
        version: 1,
        keyword: "共通検索語",
        limit: 1,
        ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "SEARCH_INVALID_CURSOR", kind: "validation" },
    });
    expect(
      await stub.search({
        version: 1,
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
      version: 1,
      operationId: "create",
      type: "create-memo",
      memo: { id: "expired", body: "期限切れメモ", timestamp: expiredAt - 1 },
    });
    await commit(stub, {
      version: 1,
      operationId: "trash",
      type: "trash-memo",
      memoId: "expired",
      trashedAt: expiredAt,
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      await stub.commit({
        version: 1,
        operationId: "restore",
        type: "restore-memo",
        memoId: "expired",
        restoredAt: Date.now(),
        expectedVersion: 2,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONTENT_NOT_FOUND", kind: "not-found" },
    });
    await commit(stub, {
      version: 1,
      operationId: "topic-create",
      type: "create-topic",
      topic: { id: "expired-topic", name: "Expired", timestamp: expiredAt - 1 },
    });
    await commit(stub, {
      version: 1,
      operationId: "document-create",
      type: "create-document",
      document: {
        id: "expired-document",
        title: "Expired",
        body: "期限切れドキュメント",
        timestamp: expiredAt - 1,
        topicId: "expired-topic",
        sourceMemoIds: [],
      },
    });
    await commit(stub, {
      version: 1,
      operationId: "topic-trash",
      type: "trash-topic",
      topicId: "expired-topic",
      trashedAt: expiredAt,
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM topics
             WHERE id = 'expired-topic'`,
          )
          .one().count,
      ).toBe(0);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM content
             WHERE id = 'expired-document'`,
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("enforces OCC while no-op updates and restores preserve revision history", async () => {
    const stub = object("occ-history");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "occ-history",
        now: 1,
      }),
    );
    await commit(stub, {
      version: 1,
      operationId: "create",
      type: "create-memo",
      actor: { kind: "user", id: "user:one" },
      memo: { id: "memo", body: "first", timestamp: 2 },
    });
    await commit(stub, {
      version: 1,
      operationId: "update",
      type: "update-memo",
      actor: {
        kind: "aiClient",
        id: "ai:writer",
        clientName: "Research Assistant",
      },
      expectedVersion: 0,
      changeReason: "clarify",
      memo: { id: "memo", body: "second", timestamp: 3 },
    });
    expect(
      await stub.commit({
        version: 1,
        operationId: "stale",
        type: "update-memo",
        expectedVersion: 0,
        memo: { id: "memo", body: "stale", timestamp: 4 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CONTENT_VERSION_CONFLICT", kind: "conflict" },
    });
    await commit(stub, {
      version: 1,
      operationId: "no-op",
      type: "update-memo",
      expectedVersion: 1,
      memo: { id: "memo", body: "second", timestamp: 5 },
    });
    await commit(stub, {
      version: 1,
      operationId: "trash",
      type: "trash-memo",
      expectedVersion: 1,
      memoId: "memo",
      trashedAt: 6,
    });
    await commit(stub, {
      version: 1,
      operationId: "restore",
      type: "restore-memo",
      expectedVersion: 2,
      memoId: "memo",
      restoredAt: 7,
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{
            version: number;
            latest_revision_version: number;
            updated_by: string;
          }>(
            `SELECT version, latest_revision_version, updated_by
             FROM content WHERE id = 'memo'`,
          )
          .one(),
      ).toEqual({
        version: 3,
        latest_revision_version: 2,
        updated_by: "local-user",
      });
      expect(
        state.storage.sql
          .exec<{
            actor_kind: string;
            actor_id: string;
            actor_client_name: string | null;
            change_reason: string | null;
          }>(
            `SELECT actor_kind, actor_id, actor_client_name, change_reason
             FROM content_revisions
             WHERE content_id = 'memo' ORDER BY version`,
          )
          .toArray(),
      ).toEqual([
        {
          actor_kind: "user",
          actor_id: "user:one",
          actor_client_name: null,
          change_reason: null,
        },
        {
          actor_kind: "aiClient",
          actor_id: "ai:writer",
          actor_client_name: "Research Assistant",
          change_reason: "clarify",
        },
      ]);
    });
  });

  it("bounds candidate materialization before loading multi-megabyte bodies", async () => {
    const stub = object("candidate-budget");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "candidate-budget",
        now: 1,
      }),
    );
    await runInDurableObject(stub, (_instance, state) => {
      const body = `quota-token${"x".repeat(1024 * 1024 - 11)}`;
      const projection = new Fts5SearchAdapter(state.storage.sql);
      for (let index = 0; index < 5; index += 1) {
        const id = `memo-${index}`;
        state.storage.sql.exec(
          `INSERT INTO content(
             id, kind, title, body, created_at, updated_at
           ) VALUES (?, 'memo', '', ?, ?, ?)`,
          id,
          body,
          index + 2,
          index + 2,
        );
        projection.upsert({
          type: "memo",
          id,
          body,
          timestamp: index + 2,
        });
      }
    });
    expect(
      await stub.search({ version: 1, keyword: "quota-token" }),
    ).toMatchObject({
      ok: false,
      error: { code: "SEARCH_QUERY_TOO_COMPLEX", kind: "validation" },
    });
  });

  it("honors literal short queries and deterministic ranking boundaries", async () => {
    const stub = object("ranking-boundaries");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "ranking-boundaries",
        now: 1,
      }),
    );
    await commit(stub, {
      version: 1,
      operationId: "literal",
      type: "create-memo",
      memo: { id: "literal", body: "symbols a*b and x", timestamp: 10 },
    });
    expect((await query(stub, "x")).items.map(({ id }) => id)).toEqual([
      "literal",
    ]);
    expect((await query(stub, "a*")).items.map(({ id }) => id)).toEqual([
      "literal",
    ]);
    expect((await query(stub, "a*b")).items.map(({ id }) => id)).toEqual([
      "literal",
    ]);
    await commit(stub, {
      version: 1,
      operationId: "topic",
      type: "create-topic",
      topic: { id: "topic", name: "Rank", timestamp: 11 },
    });
    await commit(stub, {
      version: 1,
      operationId: "rank-document",
      type: "create-document",
      document: {
        id: "rank-document",
        title: "ranking-token",
        body: "body",
        timestamp: 12,
        topicId: "topic",
        sourceMemoIds: [],
      },
    });
    await commit(stub, {
      version: 1,
      operationId: "rank-memo",
      type: "create-memo",
      memo: { id: "rank-memo", body: "ranking-token", timestamp: 13 },
    });
    expect(
      (await query(stub, "ranking-token")).items.map(({ id }) => id),
    ).toEqual(["rank-document", "rank-memo"]);
    const first = await query(stub, "ranking-token", { limit: 1 });
    expect(
      await stub.search({
        version: 1,
        keyword: "ranking-token",
        page: 2,
        limit: 1,
        ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "SEARCH_INVALID_PAGINATION", kind: "validation" },
    });
  });

  it("serves UI and AI consumers through the same search capability", async () => {
    const stub = object("ui-ai-contract");
    value(
      await stub.initialize({
        operationId: "init",
        userId: "ui-ai-contract",
        now: 1,
      }),
    );
    await commit(stub, {
      version: 1,
      operationId: "memo",
      type: "create-memo",
      memo: { id: "memo", body: "shared capability", timestamp: 2 },
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const searchIndex = new Fts5SearchAdapter(state.storage.sql);
      const query = {
        keyword: "shared capability",
        pagination: { limit: 20 },
      } as const;
      const uiResult = await new UiSearchConsumer(searchIndex).search(query);
      const aiResult = await new AiSearchConsumer(searchIndex).search(query);
      expect(aiResult).toEqual(uiResult);
      expect(uiResult.items.map(({ id }) => id)).toEqual(["memo"]);
    });
  });
});
