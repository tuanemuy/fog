import type { ActiveMemo } from "@repo/core/domain/memo/entity";

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
