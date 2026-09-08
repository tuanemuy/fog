import type { Actor } from "@repo/core/domain/identity/valueObject";
import type { ActiveMemo, MemoRevision } from "@repo/core/domain/memo/entity";
import type { MemoRevisionSummary } from "@repo/core/domain/memo/ports/memoRepository";

export type MemoView = Readonly<{
  id: string;
  body: string;
  postedAt: Date;
  updatedAt: Date;
  latestRevisionNumber: number;
  /** The OCC token the editor carries into `editMemo`. */
  version: number;
}>;

export type SourceDocumentView = Readonly<{
  documentId: string;
  title: string;
  isTrashed: boolean;
}>;

export type TimelineItemView = MemoView &
  Readonly<{ sourceDocuments: readonly SourceDocumentView[] }>;

export type TimelinePageView = Readonly<{
  items: readonly TimelineItemView[];
  nextCursor: string | null;
}>;

export type ActorView =
  | Readonly<{ kind: "user" }>
  | Readonly<{ kind: "aiClient"; clientName: string }>;

export function toMemoView(memo: ActiveMemo): MemoView {
  return {
    id: memo.id,
    body: memo.body,
    postedAt: memo.postedAt,
    updatedAt: memo.updatedAt,
    latestRevisionNumber: memo.latestRevisionNumber,
    version: memo.version,
  };
}

/** A window around an anchor: the continuation in both directions. */
export type TimelineWindowView = Readonly<{
  items: readonly TimelineItemView[];
  /** The memo the anchor resolved to (one of `items`); the screen scrolls to it. */
  pivotId: string | null;
  olderCursor: string | null;
  newerCursor: string | null;
}>;

export type MemoTargetState = "found" | "trashed" | "notFound";

/** `showMemoInTimeline`: the window plus where the target stands. */
export type MemoWindowView = TimelineWindowView &
  Readonly<{ targetState: MemoTargetState; targetMemoId: string }>;

export type RevisionSummaryView = Readonly<{
  revisionNumber: number;
  actor: ActorView;
  createdAt: Date;
}>;

export type RevisionView = RevisionSummaryView & Readonly<{ body: string }>;

export type MemoRevisionsView = Readonly<{
  memoId: string;
  latestRevisionNumber: number;
  /** Ascending by `revisionNumber`; never empty for an existing memo. */
  revisions: readonly RevisionSummaryView[];
}>;

export type RevisionDiffView = Readonly<{
  base: RevisionView;
  target: RevisionView;
}>;

/** What the warning shows when somebody else edited first (`editMemo`). */
export type ConflictView = Readonly<{
  currentBody: string;
  /** Passed back as `expectedVersion` by "save anyway". */
  currentVersion: number;
  latestRevision: RevisionSummaryView;
}>;

export type EditMemoView = Readonly<{
  result: "saved" | "unchanged" | "conflict";
  memo: MemoView;
  conflict: ConflictView | null;
}>;

export type RollbackMemoView = Readonly<{
  result: "rolledBack" | "unchanged";
  memo: MemoView;
}>;

/** Only the client name crosses; the connection id and the user id stay inside. */
export function toActorView(actor: Actor): ActorView {
  return actor.kind === "user"
    ? { kind: "user" }
    : { kind: "aiClient", clientName: actor.clientName };
}

export function toRevisionSummaryView(
  summary: MemoRevisionSummary,
): RevisionSummaryView {
  return {
    revisionNumber: summary.revisionNumber,
    actor: toActorView(summary.actor),
    createdAt: summary.createdAt,
  };
}

export function toRevisionView(revision: MemoRevision): RevisionView {
  return { ...toRevisionSummaryView(revision), body: revision.body };
}

/** The timeline projection. The source-document trail joins with the knowledge slice. */
export function toTimelineItemView(memo: ActiveMemo): TimelineItemView {
  return { ...toMemoView(memo), sourceDocuments: [] };
}
