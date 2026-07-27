import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { RpcResult } from "@repo/core/application/identity/contracts";
import type {
  SearchPage,
  SemanticRpcCommand,
} from "@repo/core/application/search/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalUserDataDurableObject as UserDataDurableObject } from "../../testing/LocalUserDataDurableObject";
import type { AccountHomeDurableObject } from "../AccountHomeDurableObject";

type TestEnv = Readonly<{
  USER_DATA: DurableObjectNamespace<UserDataDurableObject>;
  ACCOUNT_HOME: DurableObjectNamespace<AccountHomeDurableObject>;
}>;

type SearchStub = Readonly<{
  search(query: {
    version: 1;
    keyword: string;
    limit?: number;
  }): Promise<RpcResult<SearchPage>>;
}>;

const bindings = env as unknown as TestEnv;

afterEach(() => reset());

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function userData(name: string) {
  return bindings.USER_DATA.getByName(name);
}

async function initialize(
  object: DurableObjectStub<UserDataDurableObject>,
  userId: string,
): Promise<void> {
  value(
    await object.initialize({
      operationId: `initialize:${userId}`,
      userId,
      now: 1,
    }),
  );
}

async function search(
  object: DurableObjectStub<UserDataDurableObject>,
  keyword: string,
): Promise<SearchPage> {
  return value(
    await (object as unknown as SearchStub).search({
      version: 1,
      keyword,
      limit: 20,
    }),
  );
}

describe("Durable Object infrastructure contracts", () => {
  it("keeps each user's data physically isolated", async () => {
    const first = userData("isolation-user-1");
    const second = userData("isolation-user-2");
    await initialize(first, "isolation-user-1");
    await initialize(second, "isolation-user-2");
    const command: SemanticRpcCommand = {
      version: 1,
      type: "create-memo",
      operationId: "create-private-memo",
      memo: {
        id: "memo-private",
        body: "東京駅の非公開メモ",
        timestamp: 2,
      },
    };
    value(await first.commit(command));

    expect((await search(first, "東京駅")).items).toHaveLength(1);
    expect((await search(second, "東京駅")).items).toHaveLength(0);
  });

  it("rolls back the main write when the FTS projection fails", async () => {
    const object = userData("projection-rollback");
    await initialize(object, "projection-rollback");
    await runInDurableObject(object, async (instance, state) => {
      state.storage.sql.exec("DROP TABLE search_fts");
      const result = await (instance as UserDataDurableObject).commit({
        version: 1,
        type: "create-memo",
        operationId: "failing-projection",
        memo: {
          id: "memo-failed",
          body: "索引更新が失敗する",
          timestamp: 2,
        },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "infrastructure" },
      });
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM content WHERE id = 'memo-failed'",
          )
          .one().count,
      ).toBe(0);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM idempotency WHERE operation_id = 'failing-projection'",
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("rolls back trash and its retention job when projection removal fails", async () => {
    const object = userData("trash-job-rollback");
    await initialize(object, "trash-job-rollback");
    value(
      await object.commit({
        version: 1,
        type: "create-memo",
        operationId: "create",
        memo: { id: "memo", body: "atomic trash", timestamp: 2 },
      }),
    );
    await runInDurableObject(object, async (instance, state) => {
      state.storage.sql.exec("DROP TABLE search_fts");
      expect(
        await (instance as UserDataDurableObject).commit({
          version: 1,
          type: "trash-memo",
          operationId: "trash",
          memoId: "memo",
          trashedAt: 3,
          expectedVersion: 0,
        }),
      ).toMatchObject({
        ok: false,
        error: { kind: "infrastructure" },
      });
      expect(
        state.storage.sql
          .exec<{ trashed_at: number | null }>(
            "SELECT trashed_at FROM content WHERE id = 'memo'",
          )
          .one().trashed_at,
      ).toBeNull();
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM jobs WHERE kind = 'purge-trash'",
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("persists versioned deletion authority across eviction", async () => {
    const object = userData("identity-delete-marker");
    expect(
      value(
        await object.identityInitializeV1({
          version: 1,
          operationId: "initialize",
          payload: { userId: "identity-delete-marker", now: 1 },
        }),
      ).userId,
    ).toBe("identity-delete-marker");
    const deletion = {
      version: 1,
      operationId: "delete",
      payload: { userId: "identity-delete-marker" },
    } as const;
    expect(value(await object.identityDeleteAllV1(deletion))).toEqual({
      deleted: true,
    });
    expect(value(await object.identityDeleteAllV1(deletion))).toEqual({
      deleted: true,
    });
    await evictDurableObject(object);
    expect(
      value(
        await object.identityGetStatusV1({
          version: 1,
          payload: { userId: "identity-delete-marker" },
        }),
      ),
    ).toEqual({ initialized: false, deleted: true });
    expect(
      await object.identityInitializeV1({
        version: 1,
        operationId: "reinitialize",
        payload: { userId: "identity-delete-marker", now: 2 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "USER_DATA_DELETED", kind: "conflict" },
    });
  });

  it("refuses Account Home restore at the actual RPC boundary", async () => {
    const result =
      await bindings.ACCOUNT_HOME.getByName("restore-forbidden").restore();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_HOME_RESTORE_FORBIDDEN" },
    });
  });
});
