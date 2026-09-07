import type { MemoView, TimelinePageView } from "./view";

/** `UserActor` as primitives; the DO rebuilds the value objects. */
export type UserActorDto = Readonly<{ kind: "user"; userId: string }>;

export type PostMemoDto = Readonly<{ body: string; actor: UserActorDto }>;

export type TimelineQueryDto = Readonly<{
  cursor: string | null;
  direction: "older" | "newer";
  limit: number;
  keyword: string | null;
}>;

/** The request Worker's entry to the memo side of the User Data DO. */
export interface MemoGateway {
  postMemo(userId: string, input: PostMemoDto): Promise<MemoView>;
  getTimeline(
    userId: string,
    query: TimelineQueryDto,
  ): Promise<TimelinePageView>;
}
