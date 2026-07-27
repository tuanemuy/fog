import type { RpcResult } from "@repo/core/application/identity/contracts";
import type {
  SearchPage,
  SemanticCommand,
} from "@repo/core/application/search/contracts";
import type { UserDataDurableObject } from "../durable-objects/UserDataDurableObject";

type LifecycleEnv = Readonly<{
  LOCAL_LIFECYCLE_ENABLED: string;
  USER_DATA: DurableObjectNamespace<UserDataDurableObject>;
}>;

type SearchCapableStub = Readonly<{
  search(query: {
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
  const commands: readonly SemanticCommand[] = [
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
      memo: { id: "memo-1", body: "東京駅の復旧メモ", timestamp: 5 },
    },
    {
      version: 1,
      type: "trash-document",
      operationId: `${runId}:trash-document`,
      documentId: "document-1",
      trashedAt: 6,
    },
    {
      version: 1,
      type: "restore-document",
      operationId: `${runId}:restore-document`,
      document: {
        id: "document-1",
        title: "耐障害性",
        body: "東京駅から始める運用設計",
        timestamp: 7,
        topicId: "topic-1",
        sourceMemoIds: ["memo-1"],
      },
    },
    {
      version: 1,
      type: "trash-memo",
      operationId: `${runId}:trash-memo`,
      memoId: "memo-1",
      trashedAt: 8,
    },
    {
      version: 1,
      type: "restore-memo",
      operationId: `${runId}:restore-memo`,
      memo: { id: "memo-1", body: "東京駅の復旧メモ", timestamp: 9 },
    },
    {
      version: 1,
      type: "remove-document",
      operationId: `${runId}:remove-document`,
      documentId: "document-1",
      removedAt: 10,
    },
    {
      version: 1,
      type: "remove-memo",
      operationId: `${runId}:remove-memo`,
      memoId: "memo-1",
      removedAt: 11,
    },
  ];
  const observations: Array<Readonly<{ step: string; page: SearchPage }>> = [];
  for (const command of commands) {
    value(await object.commit(command));
    observations.push({
      step: command.type,
      page: value(
        await (object as unknown as SearchCapableStub).search({
          keyword: "東京駅",
          limit: 20,
        }),
      ),
    });
  }
  return {
    localOnly: true,
    operations: commands.map(({ type, operationId }) => ({
      type,
      operationId,
    })),
    observations,
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
