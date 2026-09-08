import type { ActiveMemo } from "@repo/core/domain/memo/entity";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import { type TimelineItemView, toMemoView } from "./view";

/**
 * The 「→ ドキュメントX」 trail of a page of memos (S-TL-07): one reverse
 * lookup of the links for the whole page, one summary read of the cited
 * documents — never one query per memo. A trashed document stays on the
 * trail as `isTrashed` (shown, not navigable); a hard-deleted one is
 * gone with its link (ADR-003). Links are ordered by when they were made.
 */
export function attachSourceDocuments(
  ctx: UserDataUnitOfWorkContext,
  memos: readonly ActiveMemo[],
): TimelineItemView[] {
  if (memos.length === 0) return [];
  const links = ctx.documentRepository.listSourceLinksByMemos(
    memos.map((memo) => memo.id),
  );
  const documents = new Map(
    ctx.documentRepository
      .listSummariesByIdsIncludingTrashed(links.map((link) => link.documentId))
      .map((summary) => [summary.id as string, summary] as const),
  );
  const byMemo = new Map<
    string,
    TimelineItemView["sourceDocuments"][number][]
  >();
  for (const link of [...links].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.documentId.localeCompare(b.documentId),
  )) {
    const document = documents.get(link.documentId);
    if (!document) continue;
    const trail = byMemo.get(link.memoId) ?? [];
    trail.push({
      documentId: document.id,
      title: document.title,
      isTrashed: document.status === "trashed",
    });
    byMemo.set(link.memoId, trail);
  }
  return memos.map((memo) => ({
    ...toMemoView(memo),
    sourceDocuments: byMemo.get(memo.id) ?? [],
  }));
}
