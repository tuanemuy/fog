import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { RpcResult } from "@repo/core/application/identity/contracts";
import { afterEach, expect, it } from "vitest";
import type { UserDataDurableObject } from "../../../apps/web/app/durable-objects/UserDataDurableObject";

type TestEnv = {
  USER_DATA: DurableObjectNamespace<UserDataDurableObject>;
};

afterEach(() => reset());

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

it("supports workerd FTS5 trigram, short fallback, snippets, and stable pages", async () => {
  const namespace = (env as unknown as TestEnv).USER_DATA;
  const object = namespace.get(namespace.idFromName("fts5-spike"));
  await object.initialize({
    operationId: "init",
    userId: "fts5-spike",
    now: 1,
  });
  for (const [id, body] of [
    ["a", "東京駅の構内を歩く"],
    ["b", "東京駅の周辺を歩く"],
    ["c", "京都駅の周辺を歩く"],
  ] as const) {
    await object.commit({
      type: "upsert-content",
      operationId: `create-${id}`,
      entry: {
        id,
        kind: "memo",
        title: id,
        body,
        topicArchived: false,
        sourceLinks: [],
        updatedAt: 1,
      },
    });
  }
  expect(value(await object.search({ text: "東京駅" })).items).toHaveLength(2);
  expect(value(await object.search({ text: "東京" })).items).toHaveLength(2);
  const first = value(await object.search({ text: "周辺", limit: 1 }));
  const second = value(
    await object.search({ text: "周辺", limit: 1, offset: first.nextOffset }),
  );
  expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
  expect(first.items[0]?.snippet).toContain("<mark>");
});
