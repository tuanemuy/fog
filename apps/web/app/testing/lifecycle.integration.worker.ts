import type { RpcResult } from "@repo/core/application/identity/contracts";
import type {
  SearchPage,
  SemanticRpcCommand,
} from "@repo/core/application/search/contracts";
import type { LocalUserDataDurableObject } from "./LocalUserDataDurableObject";

export { LocalUserDataDurableObject as UserDataDurableObject } from "./LocalUserDataDurableObject";

type LifecycleEnv = Readonly<{
  LOCAL_LIFECYCLE_ENABLED: string;
  USER_DATA: DurableObjectNamespace<LocalUserDataDurableObject>;
}>;

type SearchCapableStub = Readonly<{
  search(query: {
    version: 1;
    keyword: string;
    limit?: number;
  }): Promise<RpcResult<SearchPage>>;
}>;

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

async function executeLifecycle(
  env: LifecycleEnv,
  runId: string,
): Promise<unknown> {
  const object = env.USER_DATA.getByName(`local-lifecycle-${runId}`);
  value(
    await object.initialize({
      operationId: `${runId}:init`,
      userId: `local-lifecycle-${runId}`,
      now: 1,
    }),
  );
  const commands: readonly SemanticRpcCommand[] = [
    {
      version: 1,
      type: "create-memo",
      operationId: `${runId}:create-memo`,
      memo: { id: "memo-1", body: "東京駅の設計メモ", timestamp: 2 },
    },
    {
      version: 1,
      type: "create-topic",
      operationId: `${runId}:create-topic`,
      topic: {
        id: "topic-1",
        name: "運用設計",
        sourceMemoId: "memo-1",
        timestamp: 3,
      },
    },
    {
      version: 1,
      type: "create-document",
      operationId: `${runId}:create-document`,
      document: {
        id: "document-1",
        title: "耐障害性",
        body: "東京駅から始める運用設計",
        timestamp: 4,
        topicId: "topic-1",
        sourceMemoIds: ["memo-1"],
      },
    },
    {
      version: 1,
      type: "update-memo",
      operationId: `${runId}:update-memo`,
      expectedVersion: 0,
      memo: { id: "memo-1", body: "東京駅の復旧メモ", timestamp: 6 },
    },
    {
      version: 1,
      type: "update-document",
      operationId: `${runId}:update-document`,
      expectedVersion: 0,
      changeReason: "local lifecycle edit",
      document: {
        id: "document-1",
        title: "耐障害性の復旧",
        body: "東京駅から始める復旧運用",
        timestamp: 5,
        topicId: "topic-1",
        sourceMemoIds: ["memo-1"],
      },
    },
    {
      version: 1,
      type: "trash-document",
      operationId: `${runId}:trash-document`,
      documentId: "document-1",
      trashedAt: 6,
      expectedVersion: 1,
    },
    {
      version: 1,
      type: "restore-document",
      operationId: `${runId}:restore-document`,
      documentId: "document-1",
      restoredAt: 7,
      expectedVersion: 2,
    },
    {
      version: 1,
      type: "trash-memo",
      operationId: `${runId}:trash-memo`,
      memoId: "memo-1",
      trashedAt: 8,
      expectedVersion: 1,
    },
    {
      version: 1,
      type: "restore-memo",
      operationId: `${runId}:restore-memo`,
      memoId: "memo-1",
      restoredAt: 9,
      expectedVersion: 2,
    },
    {
      version: 1,
      type: "trash-document",
      operationId: `${runId}:trash-document-before-remove`,
      documentId: "document-1",
      trashedAt: 10,
      expectedVersion: 3,
    },
    {
      version: 1,
      type: "remove-document",
      operationId: `${runId}:remove-document`,
      documentId: "document-1",
      removedAt: 11,
      expectedVersion: 4,
    },
    {
      version: 1,
      type: "trash-memo",
      operationId: `${runId}:trash-memo-before-remove`,
      memoId: "memo-1",
      trashedAt: 12,
      expectedVersion: 3,
    },
    {
      version: 1,
      type: "remove-memo",
      operationId: `${runId}:remove-memo`,
      memoId: "memo-1",
      removedAt: 13,
      expectedVersion: 4,
    },
  ];
  const expectedIds = new Map<string, readonly string[]>([
    ["create-memo", ["memo-1"]],
    ["create-topic", ["memo-1"]],
    ["create-document", ["memo-1", "document-1"]],
    ["update-document", ["memo-1", "document-1"]],
    ["update-memo", ["memo-1", "document-1"]],
    ["trash-document", ["memo-1"]],
    ["restore-document", ["memo-1", "document-1"]],
    ["trash-memo", ["document-1"]],
    ["restore-memo", ["memo-1", "document-1"]],
    ["trash-document-before-remove", ["memo-1"]],
    ["remove-document", ["memo-1"]],
    ["trash-memo-before-remove", []],
    ["remove-memo", []],
  ]);
  const observations: Array<Readonly<{ step: string; page: SearchPage }>> = [];
  for (const command of commands) {
    value(await object.commit(command));
    const step = command.operationId.slice(`${runId}:`.length);
    const page = value(
      await (object as unknown as SearchCapableStub).search({
        version: 1,
        keyword: "東京駅",
        limit: 20,
      }),
    );
    const actualIds = page.items.map(({ id }) => id);
    const expected = expectedIds.get(step);
    if (
      expected === undefined ||
      JSON.stringify(actualIds) !== JSON.stringify(expected)
    ) {
      throw new Error(
        `LIFECYCLE_ASSERTION_FAILED:${step}:${JSON.stringify(actualIds)}`,
      );
    }
    observations.push({
      step,
      page,
    });
  }
  return {
    localOnly: true,
    operations: commands.map(({ type, operationId }) => ({
      type,
      operationId,
    })),
    observations,
    assertionsPassed: true,
  };
}

export default {
  async fetch(request: Request, env: LifecycleEnv): Promise<Response> {
    const url = new URL(request.url);
    if (
      env.LOCAL_LIFECYCLE_ENABLED !== "true" ||
      url.pathname !== "/__local/lifecycle" ||
      request.method !== "POST"
    ) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const input: unknown = await request.json();
      const runId =
        typeof input === "object" &&
        input !== null &&
        "runId" in input &&
        typeof input.runId === "string" &&
        /^[a-zA-Z0-9-]{1,64}$/u.test(input.runId)
          ? input.runId
          : undefined;
      if (runId === undefined) {
        return Response.json({ error: "INVALID_RUN_ID" }, { status: 400 });
      }
      return Response.json(await executeLifecycle(env, runId));
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "LIFECYCLE_EXECUTION_FAILED",
        },
        { status: 500 },
      );
    }
  },
};
