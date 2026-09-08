import type {
  RevisionDiffView,
  RevisionView,
  RollbackMemoView,
} from "@repo/core/application/memo/view";
import { z } from "zod";
import { isNonEmptyString, isRecord } from "@/presentation/serverFnResult";

const memoIdSchema = z.string().min(1).max(200);
const revisionNumberSchema = z.number().int().min(1);

export const memoHistoryParamsSchema = z.object({ memoId: memoIdSchema });

/** Shape only; "base ≠ target" is the usecase's rule (decision J-G). */
export const diffMemoRevisionsSchema = z.object({
  memoId: memoIdSchema,
  baseRevisionNumber: revisionNumberSchema,
  targetRevisionNumber: revisionNumberSchema,
});

export const rollbackMemoSchema = z.object({
  memoId: memoIdSchema,
  targetRevisionNumber: revisionNumberSchema,
});

function isRevisionView(value: unknown): value is RevisionView {
  return (
    isRecord(value) &&
    typeof value.revisionNumber === "number" &&
    typeof value.body === "string" &&
    value.createdAt instanceof Date &&
    isRecord(value.actor)
  );
}

export function isRevisionDiffResult(
  value: unknown,
): value is RevisionDiffView {
  return (
    isRecord(value) &&
    isRevisionView(value.base) &&
    isRevisionView(value.target)
  );
}

export function isRollbackMemoResult(
  value: unknown,
): value is RollbackMemoView {
  return (
    isRecord(value) &&
    (value.result === "rolledBack" || value.result === "unchanged") &&
    isRecord(value.memo) &&
    isNonEmptyString(value.memo.id)
  );
}
