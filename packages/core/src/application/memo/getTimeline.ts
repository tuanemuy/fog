import { TimelineCursor } from "@repo/core/domain/memo/valueObject";
import { ValidationError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { TimelineQueryDto } from "./gateway";
import { type TimelinePageView, toMemoView } from "./view";

export const TIMELINE_DEFAULT_LIMIT = 50;
export const TIMELINE_MAX_LIMIT = 100;

export type GetTimelineInput = Readonly<{
  userId: string;
  cursor?: string | null;
  direction?: "older" | "newer";
  limit?: number;
  keyword?: string | null;
}>;

/** Shape checks the transport may have skipped; the DO repeats none of them. */
export function normalizeTimelineQuery(
  input: GetTimelineInput,
): TimelineQueryDto {
  const limit = input.limit ?? TIMELINE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > TIMELINE_MAX_LIMIT) {
    throw new ValidationError(
      "INVALID_LIMIT",
      `limit must be an integer between 1 and ${TIMELINE_MAX_LIMIT}`,
    );
  }
  const direction = input.direction ?? "older";
  const cursor = input.cursor ?? null;
  if (direction === "newer" && cursor === null) {
    throw new ValidationError(
      "CURSOR_REQUIRED",
      "A cursor is required when reading newer memos",
    );
  }
  const keyword = input.keyword?.trim() ?? "";
  return {
    cursor,
    direction,
    limit,
    keyword: keyword.length === 0 ? null : keyword,
  };
}

/** S-TL-02 / S-TL-03 / S-TL-07, request side. */
export async function getTimeline({
  container,
  input,
}: ServiceArgs<GetTimelineInput>): Promise<TimelinePageView> {
  return container.memoGateway.getTimeline(
    input.userId,
    normalizeTimelineQuery(input),
  );
}

/**
 * Inside the DO. The source-document trail (`sourceDocuments`) joins with the
 * knowledge slice; until then every item carries an empty list.
 */
export function getTimelineProcedure(
  ctx: UserDataUnitOfWorkContext,
  query: TimelineQueryDto,
): TimelinePageView {
  const page = ctx.memoRepository.findTimelinePage({
    cursor: query.cursor === null ? null : TimelineCursor.create(query.cursor),
    direction: query.direction,
    limit: query.limit,
    keyword: query.keyword,
  });
  return {
    items: page.items.map((memo) => ({
      ...toMemoView(memo),
      sourceDocuments: [],
    })),
    nextCursor: page.nextCursor,
  };
}
