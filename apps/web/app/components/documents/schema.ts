import type {
  CreateDocumentView,
  DocumentConflictView,
  DocumentDiffView,
  DocumentRevisionView,
  EditDocumentView,
  RollbackDocumentView,
} from "@repo/core/application/knowledge/view";
import { z } from "zod";
import { isNonEmptyString, isRecord } from "@/presentation/serverFnResult";

// Transport bounds only; the value objects hold the business rules. The
// body bound is UTF-16 units — twice the code-point limit — so a legitimate
// body of non-BMP text is not refused before the value object sees it
// (decision △-1).
const idSchema = z.string().min(1).max(200);
const titleSchema = z.string().max(400);
const bodySchema = z.string().max(800_000);
const changeReasonSchema = z.string().max(400).nullable();
const revisionNumberSchema = z.number().int().min(1);

export const createDocumentSchema = z.object({
  topicId: idSchema,
  title: titleSchema,
  body: bodySchema,
  sourceMemoIds: z.array(idSchema).max(100),
});

/** `expectedVersion` is checked here alone (decision J-F): a non-negative integer. */
export const editDocumentSchema = z.object({
  documentId: idSchema,
  title: titleSchema,
  body: bodySchema,
  changeReason: changeReasonSchema,
  expectedVersion: z.number().int().min(0),
});

export const trashDocumentSchema = z.object({ documentId: idSchema });

export const rollbackDocumentSchema = z.object({
  documentId: idSchema,
  revisionNumber: revisionNumberSchema,
});

/** Shape only; "base ≠ target" is the usecase's rule (decision J-G). */
export const diffDocumentRevisionsSchema = z.object({
  documentId: idSchema,
  baseRevisionNumber: revisionNumberSchema,
  targetRevisionNumber: revisionNumberSchema,
});

export function isCreateDocumentResult(
  value: unknown,
): value is CreateDocumentView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.topicId) &&
    Array.isArray(value.sourceMemoIds)
  );
}

function isRevisionMeta(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.revisionNumber === "number" &&
    typeof value.changeReason === "string" &&
    value.createdAt instanceof Date &&
    isRecord(value.actor)
  );
}

function isConflictView(value: unknown): value is DocumentConflictView {
  return (
    isRecord(value) &&
    typeof value.currentTitle === "string" &&
    typeof value.currentBody === "string" &&
    typeof value.currentVersion === "number" &&
    isRevisionMeta(value.latestRevision)
  );
}

/** What `editDocumentFn` resolves to: a `conflict` answer must carry its view. */
export function isEditDocumentResult(
  value: unknown,
): value is EditDocumentView {
  if (
    !isRecord(value) ||
    typeof value.latestRevision !== "number" ||
    typeof value.version !== "number"
  ) {
    return false;
  }
  switch (value.result) {
    case "saved":
    case "unchanged":
      return value.conflict === null;
    case "conflict":
      return isConflictView(value.conflict);
    default:
      return false;
  }
}

/** `trashDocumentFn` answers this in place of `void`, so the client can check it. */
export type TrashDocumentResult = Readonly<{ deleted: true }>;

export function isTrashDocumentResult(
  value: unknown,
): value is TrashDocumentResult {
  return isRecord(value) && value.deleted === true;
}

export function isRollbackDocumentResult(
  value: unknown,
): value is RollbackDocumentView {
  return (
    isRecord(value) &&
    typeof value.changed === "boolean" &&
    typeof value.latestRevision === "number"
  );
}

function isRevisionView(value: unknown): value is DocumentRevisionView {
  return (
    isRevisionMeta(value) &&
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.body === "string"
  );
}

export function isDocumentDiffResult(
  value: unknown,
): value is DocumentDiffView {
  return (
    isRecord(value) &&
    isRevisionView(value.base) &&
    isRevisionView(value.target)
  );
}
