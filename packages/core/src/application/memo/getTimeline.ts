import { TimelineCursor } from "@repo/core/domain/memo/valueObject";
import { ValidationError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { TimelineQueryDto } from "./gateway";
import { attachSourceDocuments } from "./sourceDocuments";
import type { TimelinePageView } from "./view";

export const TIMELINE_DEFAULT_LIMIT = 50;
export const TIMELINE_MAX_LIMIT = 100;

export type GetTimelineInput = Readonly<{
  userId: string;
  cursor?: string | null;
  direction?: "older" | "newer";
  limit?: number;
  keyword?: string | null;
}>;

/** `limit` defaulted and bounded; shared by every timeline read. */
export function normalizeLimit(limit: number | undefined): number {
  const value = limit ?? TIMELINE_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > TIMELINE_MAX_LIMIT) {
    throw new ValidationError(
      "INVALID_LIMIT",
      `limit must be an integer between 1 and ${TIMELINE_MAX_LIMIT}`,
    );
  }
  return value;
}

/** `keyword` trimmed; blank is no filter. */
export function normalizeKeyword(
  keyword: string | null | undefined,
): string | null {
  const trimmed = keyword?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

/** Shape checks the transport may have skipped; the DO repeats none of them. */
export function normalizeTimelineQuery(
  input: GetTimelineInput,
): TimelineQueryDto {
  const limit = normalizeLimit(input.limit);
  const direction = input.direction ?? "older";
  const cursor = input.cursor ?? null;
  if (direction === "newer" && cursor === null) {
    throw new ValidationError(
      "CURSOR_REQUIRED",
      "A cursor is required when reading newer memos",
    );
  }
  return { cursor, direction, limit, keyword: normalizeKeyword(input.keyword) };
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
    items: attachSourceDocuments(ctx, page.items),
    nextCursor: page.nextCursor,
  };
}
