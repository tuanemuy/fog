/** `UserActor` as primitives; the DO rebuilds the value objects. */
import type {
  ActorDto,
  AiClientActorDto,
  UserActorDto,
} from "../identity/actorDto";
import type {
  EditMemoView,
  MemoRevisionsView,
  MemoView,
  MemoWindowView,
  RecentMemosView,
  RevisionDiffView,
  RollbackMemoView,
  TimelinePageView,
  TimelineWindowView,
  UpdateMemoByAiView,
} from "./view";

export type { ActorDto, AiClientActorDto, UserActorDto };

/** Both faces post through here; the request-side `postMemo` narrows its own input to a human. */
export type PostMemoDto = Readonly<{ body: string; actor: ActorDto }>;

export type UpdateMemoByAiDto = Readonly<{
  memoId: string;
  body: string;
  actor: AiClientActorDto;
}>;

export type RecentMemosDto = Readonly<{ limit: number }>;

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
  /** MCP `update_memo`: whole-body replacement on the latest state, no version. */
  updateMemoByAi(
    userId: string,
    input: UpdateMemoByAiDto,
  ): Promise<UpdateMemoByAiView>;
  /** MCP `recent_memos`: the newest active memos, no cursor. */
  recentMemos(userId: string, input: RecentMemosDto): Promise<RecentMemosView>;
  /** MCP `get` for a memo: active only. */
  getMemo(userId: string, memoId: string): Promise<MemoView>;
}
