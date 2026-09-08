import { ValidationError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { RecentMemosDto } from "./gateway";
import { type RecentMemosView, toAiMemoView } from "./view";

export const RECENT_MEMOS_DEFAULT_LIMIT = 20;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;

export type RecentMemosInput = Readonly<{
  userId: string;
  /** 1–100; 20 when omitted. */
  limit?: number;
}>;

/** S-AI-02: the newest active memos, fixed to the timeline's head; no cursor, no keyword. */
export async function recentMemos({
  container,
  input,
}: ServiceArgs<RecentMemosInput>): Promise<RecentMemosView> {
  const limit = input.limit ?? RECENT_MEMOS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < LIMIT_MIN || limit > LIMIT_MAX) {
    throw new ValidationError(
      "INVALID_LIMIT",
      `limit must be an integer between ${LIMIT_MIN} and ${LIMIT_MAX}`,
    );
  }
  return container.memoGateway.recentMemos(input.userId, { limit });
}

export function recentMemosProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: RecentMemosDto,
): RecentMemosView {
  const page = ctx.memoRepository.findTimelinePage({
    cursor: null,
    direction: "older",
    limit: input.limit,
    keyword: null,
  });
  return { items: page.items.map(toAiMemoView) };
}
