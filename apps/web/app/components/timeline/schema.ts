import type { TimelinePageView } from "@repo/core/application/memo/view";
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
});

export type TimelinePageInput = z.infer<typeof timelinePageSchema>;

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
