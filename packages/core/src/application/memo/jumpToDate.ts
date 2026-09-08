import { ValidationError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { JumpToDateDto } from "./gateway";
import { normalizeKeyword, normalizeLimit } from "./getTimeline";
import { type TimelineWindowView, toTimelineItemView } from "./view";

export type JumpToDateInput = Readonly<{
  userId: string;
  /** The start of the day in the display time zone, as the presentation computed it. */
  date: Date;
  /** The start of the next day (exclusive). */
  dayEnd: Date;
  limit?: number;
  keyword?: string | null;
}>;

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function normalizeJumpToDate(input: JumpToDateInput): JumpToDateDto {
  if (!isValidDate(input.date) || !isValidDate(input.dayEnd)) {
    throw new ValidationError("INVALID_DATE", "date and dayEnd must be valid");
  }
  if (input.dayEnd.getTime() <= input.date.getTime()) {
    throw new ValidationError("INVALID_DATE", "dayEnd must be after date");
  }
  return {
    date: input.date,
    dayEnd: input.dayEnd,
    limit: normalizeLimit(input.limit),
    keyword: normalizeKeyword(input.keyword),
  };
}

/** S-TL-03, request side: the window around a day, keyword filter kept. */
export async function jumpToDate({
  container,
  input,
}: ServiceArgs<JumpToDateInput>): Promise<TimelineWindowView> {
  return container.memoGateway.jumpToDate(
    input.userId,
    normalizeJumpToDate(input),
  );
}

export function jumpToDateProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: JumpToDateDto,
): TimelineWindowView {
  const window = ctx.memoRepository.findTimelineAround(
    { kind: "date", from: input.date, toExclusive: input.dayEnd },
    { limit: input.limit, keyword: input.keyword },
  );
  return {
    items: window.items.map(toTimelineItemView),
    olderCursor: window.olderCursor,
    newerCursor: window.newerCursor,
  };
}
