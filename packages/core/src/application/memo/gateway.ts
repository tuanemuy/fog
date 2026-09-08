import type {
  EditMemoView,
  MemoRevisionsView,
  MemoView,
  MemoWindowView,
  RevisionDiffView,
  RollbackMemoView,
  TimelinePageView,
  TimelineWindowView,
} from "./view";

/** `UserActor` as primitives; the DO rebuilds the value objects. */
export type UserActorDto = Readonly<{ kind: "user"; userId: string }>;

export type PostMemoDto = Readonly<{ body: string; actor: UserActorDto }>;

export type TimelineQueryDto = Readonly<{
  cursor: string | null;
  direction: "older" | "newer";
  limit: number;
  keyword: string | null;
}>;

/** `[date, dayEnd)` is the day as the display time zone sees it. */
export type JumpToDateDto = Readonly<{
  date: Date;
  dayEnd: Date;
  limit: number;
  keyword: string | null;
}>;

export type ShowMemoDto = Readonly<{ memoId: string; limit: number }>;

export type EditMemoDto = Readonly<{
  memoId: string;
  body: string;
  expectedVersion: number;
  actor: UserActorDto;
}>;

export type DiffRevisionsDto = Readonly<{
  memoId: string;
  baseRevisionNumber: number;
  targetRevisionNumber: number;
}>;

export type RollbackMemoDto = Readonly<{
  memoId: string;
  targetRevisionNumber: number;
  actor: UserActorDto;
}>;

/** The request Worker's entry to the memo side of the User Data DO. */
export interface MemoGateway {
  postMemo(userId: string, input: PostMemoDto): Promise<MemoView>;
  getTimeline(
    userId: string,
    query: TimelineQueryDto,
  ): Promise<TimelinePageView>;
  jumpToDate(userId: string, input: JumpToDateDto): Promise<TimelineWindowView>;
  showMemoInTimeline(
    userId: string,
    input: ShowMemoDto,
  ): Promise<MemoWindowView>;
  editMemo(userId: string, input: EditMemoDto): Promise<EditMemoView>;
  listMemoRevisions(userId: string, memoId: string): Promise<MemoRevisionsView>;
  diffMemoRevisions(
    userId: string,
    input: DiffRevisionsDto,
  ): Promise<RevisionDiffView>;
  rollbackMemo(
    userId: string,
    input: RollbackMemoDto,
  ): Promise<RollbackMemoView>;
  softDeleteMemo(userId: string, memoId: string): Promise<void>;
}
