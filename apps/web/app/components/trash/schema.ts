import type { TopicListView } from "@repo/core/application/knowledge/view";
import type {
  EmptyTrashView,
  RestoreDocumentView,
  RestoreMemoView,
  RestoreTopicView,
  TrashListView,
} from "@repo/core/application/trash/view";
import { z } from "zod";
import { isRecord } from "@/presentation/serverFnResult";

/** One page of P-12; the whole trash usually fits in it (decision △-2). */
export const TRASH_PAGE_LIMIT = 100;

// Transport bounds only; the value objects hold the business rules. The
// name and description bounds are UTF-16 units, twice the code-point limits.
const idSchema = z.string().min(1).max(200);
const kindSchema = z.enum(["memo", "document", "topic"]);

export const listTrashSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1).max(TRASH_PAGE_LIMIT),
});

export const restoreMemoSchema = z.object({ memoId: idSchema });
export const restoreTopicSchema = z.object({ topicId: idSchema });

export const restoreDocumentSchema = z.object({
  documentId: idSchema,
  confirmSetRestore: z.boolean().optional(),
  destination: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("existing"), topicId: idSchema }),
      z.object({
        kind: z.literal("new"),
        name: z.string().min(1).max(200),
        description: z.string().max(1000).nullable(),
      }),
    ])
    .optional(),
});

export const hardDeleteTrashItemSchema = z.object({
  kind: kindSchema,
  id: idSchema,
});

const isDate = (value: unknown): value is Date => value instanceof Date;

function isTrashItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  if (!isDate(value.trashedAt) || !isDate(value.expiresAt)) return false;
  switch (value.kind) {
    case "memo":
      return typeof value.excerpt === "string";
    case "document":
      return (
        typeof value.title === "string" &&
        typeof value.topicId === "string" &&
        typeof value.deletedWithTopic === "boolean"
      );
    case "topic":
      return (
        typeof value.name === "string" && Array.isArray(value.setDocumentIds)
      );
    default:
      return false;
  }
}

export function isTrashList(value: unknown): value is TrashListView {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isTrashItem) &&
    typeof value.totalCount === "number" &&
    typeof value.page === "number" &&
    typeof value.limit === "number"
  );
}

export function isRestoreMemoResult(value: unknown): value is RestoreMemoView {
  return isRecord(value) && typeof value.memoId === "string";
}

export function isRestoreTopicResult(
  value: unknown,
): value is RestoreTopicView {
  return (
    isRecord(value) &&
    typeof value.topicId === "string" &&
    Array.isArray(value.restoredDocumentIds)
  );
}

export function isRestoreDocumentResult(
  value: unknown,
): value is RestoreDocumentView {
  if (!isRecord(value) || typeof value.documentId !== "string") return false;
  switch (value.result) {
    case "restored":
      return (
        value.restoredTopicId === null ||
        typeof value.restoredTopicId === "string"
      );
    case "setRestoreConfirmationRequired":
      return (
        typeof value.topicId === "string" && typeof value.topicName === "string"
      );
    case "destinationSelectionRequired":
      return true;
    default:
      return false;
  }
}

export type HardDeleteResult = Readonly<{ deleted: true }>;
export function isHardDeleteResult(value: unknown): value is HardDeleteResult {
  return isRecord(value) && value.deleted === true;
}

export function isEmptyTrashResult(value: unknown): value is EmptyTrashView {
  return (
    isRecord(value) &&
    typeof value.deletedCount === "number" &&
    typeof value.failedCount === "number"
  );
}

export function isTopicList(value: unknown): value is TopicListView {
  return (
    isRecord(value) &&
    Array.isArray(value.topics) &&
    value.topics.every(
      (t) =>
        isRecord(t) && typeof t.id === "string" && typeof t.name === "string",
    )
  );
}
