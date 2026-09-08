import type {
  ConflictView,
  EditMemoView,
  MemoView,
  TimelinePageView,
} from "@repo/core/application/memo/view";
import { z } from "zod";
import { isNonEmptyString, isRecord } from "@/presentation/serverFnResult";

// Transport bounds only; the value objects hold the business rules.
export const postMemoSchema = z.object({
  body: z.string().max(100_000),
});

/** `spec/pages/index.md` P-01: 50 memos per page. */
export const TIMELINE_PAGE_LIMIT = 50;

export const timelinePageSchema = z.object({
  cursor: z.string().min(1).max(512).nullable(),
  direction: z.enum(["older", "newer"]),
  limit: z.number().int().min(1).max(100),
  keyword: z.string().max(500).nullable(),
});

export type TimelinePageInput = z.infer<typeof timelinePageSchema>;

const memoIdSchema = z.string().min(1).max(200);

/** `expectedVersion` is checked here alone (decision J-F): a non-negative integer. */
export const editMemoSchema = z.object({
  memoId: memoIdSchema,
  body: z.string().max(100_000),
  expectedVersion: z.number().int().min(0),
});

export type EditMemoInput = z.infer<typeof editMemoSchema>;

export const softDeleteMemoSchema = z.object({ memoId: memoIdSchema });

/** What `postMemoFn` resolves to, checked at the client boundary. */
export type PostMemoResult = Readonly<{ memo: { id: string } }>;

export function isPostMemoResult(value: unknown): value is PostMemoResult {
  return (
    isRecord(value) && isRecord(value.memo) && isNonEmptyString(value.memo.id)
  );
}

/** What `loadTimelinePageFn` resolves to, checked at the client boundary. */
export function isTimelinePageResult(
  value: unknown,
): value is TimelinePageView {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    (value.nextCursor === null || isNonEmptyString(value.nextCursor))
  );
}

function isMemoView(value: unknown): value is MemoView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.body === "string" &&
    value.postedAt instanceof Date &&
    value.updatedAt instanceof Date &&
    typeof value.latestRevisionNumber === "number" &&
    typeof value.version === "number"
  );
}

function isConflictView(value: unknown): value is ConflictView {
  return (
    isRecord(value) &&
    typeof value.currentBody === "string" &&
    typeof value.currentVersion === "number" &&
    isRecord(value.latestRevision) &&
    typeof value.latestRevision.revisionNumber === "number" &&
    value.latestRevision.createdAt instanceof Date &&
    isRecord(value.latestRevision.actor)
  );
}

/** What `editMemoFn` resolves to: a `conflict` answer must carry its view. */
export function isEditMemoResult(value: unknown): value is EditMemoView {
  if (!isRecord(value) || !isMemoView(value.memo)) return false;
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

/** `softDeleteMemoFn` answers this in place of `void`, so the client can check it. */
export type SoftDeleteMemoResult = Readonly<{ deleted: true }>;

export function isSoftDeleteMemoResult(
  value: unknown,
): value is SoftDeleteMemoResult {
  return isRecord(value) && value.deleted === true;
}
