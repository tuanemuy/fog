import {
  Actor,
  type UserActor,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { Memo } from "@repo/core/domain/memo/entity";
import { MemoId, RevisionNumber } from "@repo/core/domain/memo/valueObject";
import { NotFoundError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import { memoNotFound } from "./editMemo";
import type { RollbackMemoDto } from "./gateway";
import { type RollbackMemoView, toMemoView } from "./view";

export type RollbackMemoInput = Readonly<{
  userId: string;
  memoId: string;
  targetRevisionNumber: number;
  /** Rollback exists for humans only; no AI scope carries it. */
  actor: UserActor;
}>;

/**
 * S-TL-05 "restore this content", request side. No `expectedVersion`: the
 * intent — the memo should read as that revision — does not change when
 * somebody else edited in between, and their edit stays in the history.
 */
export async function rollbackMemo({
  container,
  input,
}: ServiceArgs<RollbackMemoInput>): Promise<RollbackMemoView> {
  return container.memoGateway.rollbackMemo(input.userId, {
    memoId: MemoId.create(input.memoId),
    targetRevisionNumber: input.targetRevisionNumber,
    actor: { kind: "user", userId: input.actor.userId },
  });
}

export function rollbackMemoProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: RollbackMemoDto,
  now: Date,
): RollbackMemoView {
  const memoId = MemoId.create(input.memoId);
  const found = ctx.memoRepository.findById(memoId);
  if (found === null) throw memoNotFound();
  const targetRevision = ctx.memoRepository.findRevision(
    memoId,
    RevisionNumber.create(input.targetRevisionNumber),
  );
  if (targetRevision === null) {
    throw new NotFoundError(
      "REVISION_NOT_FOUND",
      "The target revision was not found",
    );
  }
  const actor = Actor.user(UserId.create(input.actor.userId));
  const { memo, newRevision } = Memo.rollback(
    found.entity,
    { targetRevision, actor },
    now,
  );
  if (newRevision === null) {
    return { result: "unchanged", memo: toMemoView(found.entity) };
  }
  ctx.memoRepository.save(memo, found.expectedVersion);
  ctx.memoRepository.insertRevision(newRevision);
  return { result: "rolledBack", memo: toMemoView(memo) };
}
