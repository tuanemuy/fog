import { Memo } from "@repo/core/domain/memo/entity";
import { MemoId } from "@repo/core/domain/memo/valueObject";
import { NotFoundError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { RestoreMemoView } from "./view";

export type RestoreMemoInput = Readonly<{ userId: string; memoId: string }>;

/** S-TR-02 (memo), request side. */
export async function restoreMemo({
  container,
  input,
}: ServiceArgs<RestoreMemoInput>): Promise<RestoreMemoView> {
  return container.trashGateway.restoreMemo(input.userId, input.memoId);
}

/**
 * Inside the DO. `postedAt` never changed, so the memo lands back at its
 * old place on the timeline; the repository's `save` puts its id back into
 * the citing documents' search entries.
 */
export function restoreMemoProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawMemoId: string,
  now: Date,
): RestoreMemoView {
  const memoId = MemoId.create(rawMemoId);
  const found = ctx.memoRepository.findByIdIncludingTrashed(memoId);
  if (found === null || found.entity.status !== "trashed") {
    throw new NotFoundError("MEMO_NOT_FOUND", "The memo is not in the trash");
  }
  ctx.memoRepository.save(
    Memo.restore(found.entity, now),
    found.expectedVersion,
  );
  return { memoId };
}
