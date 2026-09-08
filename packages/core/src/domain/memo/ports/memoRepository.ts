import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import type { TrashRetentionDays } from "@repo/core/domain/identity/valueObject";
import type { ActiveMemo, Memo, MemoRevision, TrashedMemo } from "../entity";
import type { MemoId, RevisionNumber, TimelineCursor } from "../valueObject";

/** What the history list draws: no body, and no `memoId` (fixed by the argument). */
export type MemoRevisionSummary = Pick<
  MemoRevision,
  "revisionNumber" | "actor" | "createdAt"
>;

export type TimelineQuery = Readonly<{
  /** `null` reads from the newest; required for `direction: "newer"`. */
  cursor: TimelineCursor | null;
  direction: "older" | "newer";
  /** 1–100 */
  limit: number;
  /** Body substring filter; `null` for no filter. */
  keyword: string | null;
}>;

export type TimelinePage = Readonly<{
  /** Always `postedAt` descending, ties broken by `id`. */
  items: readonly ActiveMemo[];
  /** The continuation in the same direction; `null` at that end. */
  nextCursor: TimelineCursor | null;
}>;

/**
 * Where a window is centred. The date anchor is a day as the display time
 * zone sees it — `[from, toExclusive)` — because the interpretation of a
 * calendar date belongs to the presentation; the repository only compares
 * instants (`spec/domains/memo.md`, findTimelineAround).
 */
export type TimelineAnchor =
  | Readonly<{ kind: "date"; from: Date; toExclusive: Date }>
  | Readonly<{ kind: "memo"; memoId: MemoId }>;

export type TimelineWindow = Readonly<{
  /** The memo the anchor resolved to; one of `items`. `null` for an empty window. */
  pivotId: MemoId | null;
  items: readonly ActiveMemo[];
  olderCursor: TimelineCursor | null;
  newerCursor: TimelineCursor | null;
}>;

/**
 * Memo aggregate persistence inside the User Data DO. Follows the
 * `TransactionalRepository` OCC contract; every method is synchronous and
 * none takes a `userId`. `findById` answers active memos only — the ground of
 * "the trash does not exist" for AI callers. Every write also maintains the
 * search projection in the same transaction.
 */
export interface MemoRepository {
  insert(memo: ActiveMemo): void;
  insertRevision(revision: MemoRevision): void;
  save(memo: Memo, expectedVersion: ExpectedVersion<Memo>): void;
  hardDelete(id: MemoId, expectedVersion: ExpectedVersion<Memo>): void;

  findById(id: MemoId): Versioned<ActiveMemo> | null;
  findByIdIncludingTrashed(id: MemoId): Versioned<Memo> | null;
  listByIdsIncludingTrashed(ids: readonly MemoId[]): readonly Memo[];
  listActiveByIds(ids: readonly MemoId[]): readonly Versioned<ActiveMemo>[];

  findTimelinePage(query: TimelineQuery): TimelinePage;
  /**
   * The window around an anchor. A date anchor pivots on the newest memo of
   * that day; when the day is empty, on whichever of the newest memo before
   * `toExclusive` and the oldest memo at or after `from` lies closer to its
   * own edge (ties go to the past). A memo anchor pivots on that memo and
   * answers an empty window when it is absent or trashed.
   */
  findTimelineAround(
    anchor: TimelineAnchor,
    query: Readonly<{ limit: number; keyword: string | null }>,
  ): TimelineWindow;

  listRevisionSummaries(memoId: MemoId): readonly MemoRevisionSummary[];
  findRevision(
    memoId: MemoId,
    revisionNumber: RevisionNumber,
  ): MemoRevision | null;

  /** Material for the trash domain's `TrashQueryPort` adapter only. */
  listTrashed(): readonly Versioned<TrashedMemo>[];

  /** No OCC token and no `version` bump: a derived value catching up. */
  recalculatePurgeAfter(
    retentionDays: TrashRetentionDays,
    limit: number,
  ): Readonly<{ updatedCount: number; hasMore: boolean }>;
}
