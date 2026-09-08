import type {
  TopicView,
  TrashTopicView,
} from "@repo/core/application/knowledge/view";
import { z } from "zod";
import { isNonEmptyString, isRecord } from "@/presentation/serverFnResult";

// Transport bounds only; the value objects hold the business rules.
const topicIdSchema = z.string().min(1).max(200);

export const createTopicSchema = z.object({
  name: z.string().max(400),
  description: z.string().max(2_000).nullable(),
});

/** At least one field must be present (`spec/usecases/knowledge.md`, updateTopic). */
export const updateTopicSchema = z
  .object({
    topicId: topicIdSchema,
    name: z.string().max(400).optional(),
    description: z.string().max(2_000).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.description !== undefined ||
      input.archived !== undefined,
    { message: "name, description or archived is required" },
  );

export const trashTopicSchema = z.object({ topicId: topicIdSchema });

export function isTopicResult(value: unknown): value is TopicView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.name === "string" &&
    (value.status === "active" || value.status === "archived") &&
    typeof value.version === "number"
  );
}

export function isTrashTopicResult(value: unknown): value is TrashTopicView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.topicId) &&
    Array.isArray(value.trashedDocumentIds)
  );
}
