import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { RpcResult } from "@repo/core/application/identity/contracts";
import type {
  SearchPage,
  SemanticCommand,
} from "@repo/core/application/search/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountHomeDurableObject } from "../AccountHomeDurableObject";
import type { UserDataDurableObject } from "../UserDataDurableObject";

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
    const command: SemanticCommand = {
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

  it("refuses Account Home restore at the actual RPC boundary", async () => {
    const result =
      await bindings.ACCOUNT_HOME.getByName("restore-forbidden").restore();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_HOME_RESTORE_FORBIDDEN" },
    });
  });
});
