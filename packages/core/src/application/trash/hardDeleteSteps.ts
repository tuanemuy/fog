import type { HardDeletePlan } from "@repo/core/domain/trash/service";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";

/**
 * Erases one plan inside the caller's transaction: documents first (their
 * revisions, source links and search entries go with them and their source
 * memos are re-projected — the repository's cascade), then memos (body and
 * revisions; the links naming them and the citing documents' entries follow
 * through `deleteSourceLinksByMemo`, ADR-003), then the topics. A row that
 * is already gone is a no-op; a row that is live is left alone. An OCC
 * mismatch propagates so the caller can defer the item.
 *
 * Limit: the FTS5 delete command is a write into the virtual table, so on
 * a Durable Object at its storage cap the erase can fail and roll back per
 * item (PH-05 △-8); the caller reports such items as failed.
 */
export function executeHardDeletePlan(
  ctx: UserDataUnitOfWorkContext,
  plan: HardDeletePlan,
): number {
  let erased = 0;
  for (const documentId of plan.documentIds) {
    const found = ctx.documentRepository.findByIdIncludingTrashed(documentId);
    if (found === null || found.entity.status !== "trashed") continue;
    ctx.documentRepository.delete(documentId, found.expectedVersion);
    erased += 1;
  }
  for (const memoId of plan.memoIds) {
    const found = ctx.memoRepository.findByIdIncludingTrashed(memoId);
    if (found === null || found.entity.status !== "trashed") continue;
    ctx.memoRepository.hardDelete(memoId, found.expectedVersion);
    ctx.documentRepository.deleteSourceLinksByMemo(memoId);
    erased += 1;
  }
  for (const topicId of plan.topicIds) {
    const found = ctx.topicRepository.findByIdIncludingTrashed(topicId);
    if (found === null || found.entity.status !== "trashed") continue;
    ctx.topicRepository.delete(topicId, found.expectedVersion);
    erased += 1;
  }
  return erased;
}
