import { MemoId } from "@repo/core/domain/memo/valueObject";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import { memoNotFound } from "./editMemo";
import { type MemoRevisionsView, toRevisionSummaryView } from "./view";

export type ListMemoRevisionsInput = Readonly<{
  userId: string;
  memoId: string;
}>;

/** S-TL-05, request side. Who and when only; bodies come with the diff. */
export async function listMemoRevisions({
  container,
  input,
}: ServiceArgs<ListMemoRevisionsInput>): Promise<MemoRevisionsView> {
  return container.memoGateway.listMemoRevisions(
    input.userId,
    MemoId.create(input.memoId),
  );
}

/** Inside the DO. A trashed memo still shows its history (human UI only). */
export function listMemoRevisionsProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawMemoId: string,
): MemoRevisionsView {
  const memoId = MemoId.create(rawMemoId);
  const found = ctx.memoRepository.findByIdIncludingTrashed(memoId);
  if (found === null) throw memoNotFound();
  return {
    memoId,
    latestRevisionNumber: found.entity.latestRevisionNumber,
    revisions: ctx.memoRepository
      .listRevisionSummaries(memoId)
      .map(toRevisionSummaryView),
  };
}
