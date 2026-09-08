import type { RequestContainer } from "@repo/core/application/di/types";
import {
  type AiClientActorDto,
  rebuildActor,
} from "@repo/core/application/identity/actorDto";
import { createDocument } from "@repo/core/application/knowledge/createDocument";
import { createTopic } from "@repo/core/application/knowledge/createTopic";
import { editDocumentByAi } from "@repo/core/application/knowledge/editDocumentByAi";
import { getDocument } from "@repo/core/application/knowledge/getDocument";
import { listTopics } from "@repo/core/application/knowledge/listTopics";
import { trashDocument } from "@repo/core/application/knowledge/trashDocument";
import { trashTopic } from "@repo/core/application/knowledge/trashTopic";
import { updateTopic } from "@repo/core/application/knowledge/updateTopic";
import { deleteMemoByAi } from "@repo/core/application/memo/deleteMemoByAi";
import { getMemo } from "@repo/core/application/memo/getMemo";
import { postMemoByAi } from "@repo/core/application/memo/postMemoByAi";
import { recentMemos } from "@repo/core/application/memo/recentMemos";
import { updateMemoByAi } from "@repo/core/application/memo/updateMemoByAi";
import { search } from "@repo/core/application/search/search";
import { z } from "zod";
import { TOOL_DESCRIPTIONS } from "./guidance";

/**
 * The allow-list of the AI API (`spec/domains/identity.md` TokenScope,
 * PH-07 §2.1): exactly the eleven tools of `spec/usecases/*.md`, each
 * bound to the one usecase module it may reach. This file, and the
 * modules it imports, are the whole of what an AI token can do — the
 * reachability test holds the import list to it, and the actor it hands
 * over is an `AiClientActorDto`, which no human-only usecase accepts.
 */
export const AI_TOOL_NAMES = [
  "search",
  "get",
  "list_topics",
  "recent_memos",
  "post_memo",
  "update_memo",
  "create_topic",
  "update_topic",
  "create_document",
  "edit_document",
  "delete",
] as const;

export type AiToolName = (typeof AI_TOOL_NAMES)[number];

export type AiToolContext = Readonly<{
  container: RequestContainer;
  userId: string;
  /** Never a `UserActor`: the human-only usecases refuse this at the type level. */
  actor: AiClientActorDto;
}>;

export type AiToolAnnotations = Readonly<{
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}>;

export type AiTool<TInput> = Readonly<{
  name: AiToolName;
  description: string;
  inputSchema: z.ZodType<TInput>;
  annotations: AiToolAnnotations;
  run(ctx: AiToolContext, input: TInput): Promise<unknown>;
}>;

// Transport bounds only (DoS); the business rules live in the value objects.
const id = z.string().min(1).max(128);
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
};
const WRITE_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

function tool<TInput>(t: AiTool<TInput>): AiTool<TInput> {
  return t;
}

const searchTool = tool({
  name: "search",
  description: TOOL_DESCRIPTIONS.search,
  inputSchema: z.object({
    keyword: z.string().min(1).max(500),
    topicId: id.optional(),
    cursor: z.string().min(1).max(20_000).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  annotations: READ,
  async run(ctx, input) {
    const page = await search({
      container: ctx.container,
      input: {
        userId: ctx.userId,
        keyword: input.keyword,
        topicId: input.topicId ?? null,
        cursor: input.cursor ?? null,
        limit: input.limit,
      },
    });
    // `topicName` is the human screen's convenience; the AI gets the id.
    return {
      items: page.items.map((item) =>
        item.type === "memo"
          ? {
              type: "memo",
              id: item.id,
              snippet: item.snippet,
              timestamp: item.timestamp,
              sourceOfDocumentIds: item.sourceOfDocumentIds,
            }
          : {
              type: "document",
              id: item.id,
              snippet: item.snippet,
              timestamp: item.timestamp,
              topicId: item.topicId,
              sourceMemoIds: item.sourceMemoIds,
            },
      ),
      count: page.count,
      nextCursor: page.nextCursor,
    };
  },
});

const getTool = tool({
  name: "get",
  description: TOOL_DESCRIPTIONS.get,
  inputSchema: z.object({ type: z.enum(["memo", "document"]), id }),
  annotations: READ,
  async run(ctx, input) {
    if (input.type === "memo") {
      const { memo } = await getMemo({
        container: ctx.container,
        input: { userId: ctx.userId, memoId: input.id },
      });
      return { type: "memo", ...memo };
    }
    const document = await getDocument({
      container: ctx.container,
      input: { userId: ctx.userId, documentId: input.id },
    });
    return {
      type: "document",
      id: document.id,
      topicId: document.topicId,
      title: document.title,
      body: document.body,
      latestRevision: document.latestRevision,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  },
});

const listTopicsTool = tool({
  name: "list_topics",
  description: TOOL_DESCRIPTIONS.list_topics,
  inputSchema: z.object({}),
  annotations: READ,
  async run(ctx) {
    const { topics } = await listTopics({
      container: ctx.container,
      // Archived topics stay discoverable: `update_topic` un-archives by id.
      input: { userId: ctx.userId, includeArchived: true },
    });
    return {
      topics: topics.map((topic) => ({
        id: topic.id,
        name: topic.name,
        description: topic.description,
        status: topic.status,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt,
        documents: topic.documents,
      })),
    };
  },
});

const recentMemosTool = tool({
  name: "recent_memos",
  description: TOOL_DESCRIPTIONS.recent_memos,
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).default(20),
  }),
  annotations: READ,
  run(ctx, input) {
    return recentMemos({
      container: ctx.container,
      input: { userId: ctx.userId, limit: input.limit },
    });
  },
});

const postMemoTool = tool({
  name: "post_memo",
  description: TOOL_DESCRIPTIONS.post_memo,
  inputSchema: z.object({ body: z.string().max(40_000) }),
  annotations: WRITE,
  run(ctx, input) {
    return postMemoByAi({
      container: ctx.container,
      input: { userId: ctx.userId, body: input.body, actor: ctx.actor },
    });
  },
});

const updateMemoTool = tool({
  name: "update_memo",
  description: TOOL_DESCRIPTIONS.update_memo,
  inputSchema: z.object({ id, body: z.string().max(40_000) }),
  annotations: WRITE_IDEMPOTENT,
  run(ctx, input) {
    return updateMemoByAi({
      container: ctx.container,
      input: {
        userId: ctx.userId,
        memoId: input.id,
        body: input.body,
        actor: ctx.actor,
      },
    });
  },
});

function topicOut(topic: {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: topic.id,
    name: topic.name,
    description: topic.description,
    status: topic.status,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
  };
}

const createTopicTool = tool({
  name: "create_topic",
  description: TOOL_DESCRIPTIONS.create_topic,
  inputSchema: z.object({
    name: z.string().max(1_000),
    description: z.string().max(4_000).nullable().optional(),
  }),
  annotations: WRITE,
  async run(ctx, input) {
    return topicOut(
      await createTopic({
        container: ctx.container,
        input: {
          userId: ctx.userId,
          name: input.name,
          description: input.description ?? null,
        },
      }),
    );
  },
});

const updateTopicTool = tool({
  name: "update_topic",
  description: TOOL_DESCRIPTIONS.update_topic,
  inputSchema: z
    .object({
      id,
      name: z.string().max(1_000).optional(),
      description: z.string().max(4_000).nullable().optional(),
      archived: z.boolean().optional(),
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.description !== undefined ||
        v.archived !== undefined,
      { message: "name, description or archived is required" },
    ),
  annotations: WRITE_IDEMPOTENT,
  async run(ctx, input) {
    return topicOut(
      await updateTopic({
        container: ctx.container,
        input: {
          userId: ctx.userId,
          topicId: input.id,
          name: input.name,
          description: input.description,
          archived: input.archived,
        },
      }),
    );
  },
});

const createDocumentTool = tool({
  name: "create_document",
  description: TOOL_DESCRIPTIONS.create_document,
  inputSchema: z.object({
    topicId: id,
    title: z.string().max(1_000),
    body: z.string().max(800_000),
    sourceMemoIds: z.array(id).max(200).default([]),
    changeReason: z.string().max(1_000).optional(),
  }),
  annotations: WRITE,
  async run(ctx, input) {
    const document = await createDocument({
      container: ctx.container,
      input: {
        userId: ctx.userId,
        // `createDocument` is a both-faces usecase and takes the domain actor.
        actor: rebuildActor(ctx.actor),
        topicId: input.topicId,
        title: input.title,
        body: input.body,
        sourceMemoIds: input.sourceMemoIds,
        changeReason: input.changeReason ?? null,
      },
    });
    return {
      id: document.id,
      topicId: document.topicId,
      title: document.title,
      body: document.body,
      latestRevision: document.latestRevision,
      sourceMemoIds: document.sourceMemoIds,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  },
});

const editDocumentTool = tool({
  name: "edit_document",
  description: TOOL_DESCRIPTIONS.edit_document,
  inputSchema: z
    .object({
      id,
      changeReason: z.string().min(1).max(1_000),
      mode: z.enum(["patch", "replaceAll"]).default("patch"),
      patches: z
        .array(
          z.object({
            oldText: z.string().max(800_000),
            newText: z.string().max(800_000),
          }),
        )
        .max(200)
        .optional(),
      body: z.string().max(800_000).optional(),
    })
    .refine(
      (v) =>
        v.mode === "patch" ? v.patches !== undefined : v.body !== undefined,
      {
        message:
          'mode "patch" requires patches; mode "replaceAll" requires body',
      },
    ),
  annotations: WRITE,
  run(ctx, input) {
    return editDocumentByAi({
      container: ctx.container,
      input: {
        userId: ctx.userId,
        actor: ctx.actor,
        documentId: input.id,
        edit:
          input.mode === "replaceAll"
            ? { mode: "replaceAll", body: input.body ?? "" }
            : { mode: "patch", patches: input.patches ?? [] },
        changeReason: input.changeReason,
      },
    });
  },
});

const deleteTool = tool({
  name: "delete",
  description: TOOL_DESCRIPTIONS.delete,
  inputSchema: z.object({ type: z.enum(["memo", "document", "topic"]), id }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
  async run(ctx, input) {
    switch (input.type) {
      case "memo":
        await deleteMemoByAi({
          container: ctx.container,
          input: { userId: ctx.userId, memoId: input.id },
        });
        return { type: "memo", id: input.id, trashed: true };
      case "document":
        await trashDocument({
          container: ctx.container,
          input: { userId: ctx.userId, documentId: input.id },
        });
        return { type: "document", id: input.id, trashed: true };
      case "topic": {
        const result = await trashTopic({
          container: ctx.container,
          input: { userId: ctx.userId, topicId: input.id },
        });
        return {
          type: "topic",
          id: input.id,
          trashed: true,
          trashedDocumentIds: result.trashedDocumentIds,
        };
      }
    }
  },
});

// biome-ignore lint/suspicious/noExplicitAny: the registry is heterogeneous by design; each entry is typed at its definition and dispatched by name.
export const AI_TOOLS: Readonly<Record<AiToolName, AiTool<any>>> = {
  search: searchTool,
  get: getTool,
  list_topics: listTopicsTool,
  recent_memos: recentMemosTool,
  post_memo: postMemoTool,
  update_memo: updateMemoTool,
  create_topic: createTopicTool,
  update_topic: updateTopicTool,
  create_document: createDocumentTool,
  edit_document: editDocumentTool,
  delete: deleteTool,
};

export function isAiToolName(value: string): value is AiToolName {
  return (AI_TOOL_NAMES as readonly string[]).includes(value);
}

/** The JSON Schema `tools/list` and `GET /api/ai` publish. */
export function toolInputJsonSchema(name: AiToolName): Record<string, unknown> {
  return z.toJSONSchema(AI_TOOLS[name].inputSchema, {
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>;
}
