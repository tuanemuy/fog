import { MemoId } from "@repo/core/domain/memo/valueObject";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import { memoNotFound } from "./editMemo";
import { type MemoView, toMemoView } from "./view";

export type GetMemoInput = Readonly<{ userId: string; memoId: string }>;

export type GetMemoOutput = Readonly<{
  memo: Readonly<{
    id: string;
    body: string;
    postedAt: Date;
    updatedAt: Date;
    latestRevisionNumber: number;
  }>;
}>;

/** S-AI-02 `get` for a memo: the whole body of an active memo; a trashed one does not exist. */
export async function getMemo({
  container,
  input,
}: ServiceArgs<GetMemoInput>): Promise<GetMemoOutput> {
  const memo = await container.memoGateway.getMemo(
    input.userId,
    MemoId.create(input.memoId),
  );
  return {
    memo: {
      id: memo.id,
      body: memo.body,
      postedAt: memo.postedAt,
      updatedAt: memo.updatedAt,
      latestRevisionNumber: memo.latestRevisionNumber,
    },
  };
}

export function getMemoProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawMemoId: string,
): MemoView {
  const found = ctx.memoRepository.findById(MemoId.create(rawMemoId));
  if (found === null) throw memoNotFound();
  return toMemoView(found.entity);
}
