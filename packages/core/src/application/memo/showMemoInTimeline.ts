import { MemoId } from "@repo/core/domain/memo/valueObject";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { ShowMemoDto } from "./gateway";
import { normalizeLimit } from "./getTimeline";
import { type MemoWindowView, toTimelineItemView } from "./view";

export type ShowMemoInTimelineInput = Readonly<{
  userId: string;
  memoId: string;
  limit?: number;
}>;

/**
 * P-04's "show this memo in the timeline" entry, request side. Absence and
 * the trash are states the screen explains, not errors.
 */
export async function showMemoInTimeline({
  container,
  input,
}: ServiceArgs<ShowMemoInTimelineInput>): Promise<MemoWindowView> {
  return container.memoGateway.showMemoInTimeline(input.userId, {
    memoId: MemoId.create(input.memoId),
    limit: normalizeLimit(input.limit),
  });
}

export function showMemoInTimelineProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: ShowMemoDto,
): MemoWindowView {
  const memoId = MemoId.create(input.memoId);
  const empty = { items: [], olderCursor: null, newerCursor: null } as const;
  const found = ctx.memoRepository.findByIdIncludingTrashed(memoId);
  if (found === null) {
    return { ...empty, targetState: "notFound", targetMemoId: memoId };
  }
  if (found.entity.status === "trashed") {
    return { ...empty, targetState: "trashed", targetMemoId: memoId };
  }
  const window = ctx.memoRepository.findTimelineAround(
    { kind: "memo", memoId },
    { limit: input.limit, keyword: null },
  );
  return {
    items: window.items.map(toTimelineItemView),
    olderCursor: window.olderCursor,
    newerCursor: window.newerCursor,
    targetState: "found",
    targetMemoId: memoId,
  };
}
