import { BusinessRuleError } from "@repo/core/domain/error";
import {
  aiGuidance,
  aiOperations,
  patchedDocument,
} from "@repo/core/domain/fog/ai";
import { type Actor, revisionReason } from "@repo/core/domain/fog/content";
import type {
  AiDocumentView,
  AiMemoView,
  AiReadRequest,
  AiReadResult,
  AiResource,
  AiWriteRequest,
} from "./aiTypes";
import { type ContentDependencies, requireVersion } from "./contentSupport";
import type { ContentRef } from "./dataTypes";
import { createDocumentServices } from "./documentServices";
import { createMemoServices } from "./memoServices";
import type { FogUnitOfWork } from "./ports";
import { createSearchServices } from "./searchServices";
import { createTopicServices } from "./topicServices";
import { createTrashServices } from "./trashServices";
import type { DocumentView, MemoView } from "./types";

const safeMemo = ({ sourceDocuments, ...memo }: MemoView): AiMemoView => ({
  ...memo,
  sourceDocuments: sourceDocuments
    .filter((source) => !source.deleted)
    .map(({ id, title }) => ({ id, title })),
});
const safeDocument = ({
  sourceMemos,
  ...document
}: DocumentView): AiDocumentView => ({
  ...document,
  sourceMemos: sourceMemos
    .filter((source) => !source.deleted)
    .map(({ id, body, createdAt }) => ({ id, body, createdAt })),
});
export function aiContentServices(
  context: FogUnitOfWork,
  deps: ContentDependencies,
) {
  const scoped = {
    ...deps,
    unitOfWork: {
      run: <T>(operation: (context: FogUnitOfWork) => Promise<T>) =>
        operation(context),
    },
  };
  return {
    ...createMemoServices(scoped),
    ...createDocumentServices(scoped),
    ...createTopicServices(scoped),
    ...createTrashServices(scoped),
    ...createSearchServices(scoped),
  };
}
type ContentServices = ReturnType<typeof aiContentServices>;
export async function readAi(
  services: ContentServices,
  actor: Actor,
  request: AiReadRequest,
): Promise<AiReadResult> {
  switch (request.operation) {
    case "guidance":
      return {
        kind: "read",
        operation: request.operation,
        data: { operations: aiOperations, guidance: aiGuidance },
      };
    case "memos.recent": {
      const page = await services.listTimeline(actor, request.input);
      return {
        kind: "read",
        operation: request.operation,
        data: { ...page, memos: page.memos.map(safeMemo) },
      };
    }
    case "memos.get":
      return {
        kind: "read",
        operation: request.operation,
        data: safeMemo(await services.getMemo(actor, request.input.id)),
      };
    case "topics.list":
      return {
        kind: "read",
        operation: request.operation,
        data: await services.listTopics(actor),
      };
    case "topics.get": {
      const detail = await services.getTopic(actor, request.input.id);
      return {
        kind: "read",
        operation: request.operation,
        data: {
          ...detail,
          documents: detail.documents.map(safeDocument),
          relatedMemos: detail.relatedMemos.map(safeMemo),
        },
      };
    }
    case "documents.get":
      return {
        kind: "read",
        operation: request.operation,
        data: safeDocument(await services.getDocument(actor, request.input.id)),
      };
    case "search":
      return {
        kind: "read",
        operation: request.operation,
        data: await services.search(actor, request.input),
      };
  }
}
export async function writeAi(
  services: ContentServices,
  actor: Actor,
  request: AiWriteRequest,
): Promise<ContentRef | null> {
  switch (request.operation) {
    case "memos.create":
      return {
        kind: "memo",
        id: (await services.createMemo(actor, request.input)).id,
      };
    case "memos.replace":
      return {
        kind: "memo",
        id: (await services.editMemo(actor, request.input)).id,
      };
    case "topics.create":
      return {
        kind: "topic",
        id: (await services.createTopic(actor, request.input)).id,
      };
    case "topics.update":
      return {
        kind: "topic",
        id: (await services.updateTopic(actor, request.input)).id,
      };
    case "documents.create":
      return {
        kind: "document",
        id: (await services.createDocument(actor, request.input)).id,
      };
    case "documents.patch": {
      const current = await services.getDocument(actor, request.input.id);
      requireVersion(current.version, request.input.expectedVersion);
      const reason = revisionReason(actor, request.input.reason, "");
      const body = patchedDocument(
        current.body,
        request.input.find,
        request.input.replace,
      );
      await services.editDocument(actor, {
        id: current.id,
        title: request.input.title ?? current.title,
        body,
        reason,
        expectedVersion: current.version,
      });
      return { kind: "document", id: current.id };
    }
    case "documents.rewrite": {
      if (request.input.confirmRewrite !== true)
        throw new BusinessRuleError(
          "REWRITE_CONFIRMATION_REQUIRED",
          "全文置換には明示的な確認が必要です。",
        );
      await services.editDocument(actor, request.input);
      return { kind: "document", id: request.input.id };
    }
    case "content.delete":
      await services.softDelete(actor, request.input);
      return null;
  }
}
export async function currentAiResource(
  context: FogUnitOfWork,
  ownerId: string,
  ref: ContentRef | null,
): Promise<AiResource | null> {
  if (!ref) return null;
  const item =
    ref.kind === "memo"
      ? await context.memos(ownerId).find(ref.id)
      : ref.kind === "topic"
        ? await context.topics(ownerId).find(ref.id)
        : await context.documents(ownerId).find(ref.id);
  return item ? { kind: ref.kind, id: item.id, version: item.version } : null;
}
