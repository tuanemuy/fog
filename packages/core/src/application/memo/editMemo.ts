import {
  Actor,
  type UserActor,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { Memo } from "@repo/core/domain/memo/entity";
import { MemoId } from "@repo/core/domain/memo/valueObject";
import { NotFoundError, SystemError, SystemErrorCode } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { EditMemoDto } from "./gateway";
import { type EditMemoView, toMemoView, toRevisionSummaryView } from "./view";

export type EditMemoInput = Readonly<{
  userId: string;
  memoId: string;
  body: string;
  /** The `version` the editor started from; the transport bounds it to a non-negative integer. */
  expectedVersion: number;
  /** Only a human may edit through this face; the AI side is `update_memo`. */
  actor: UserActor;
}>;

/** S-TL-04, request side. */
export async function editMemo({
  container,
  input,
}: ServiceArgs<EditMemoInput>): Promise<EditMemoView> {
  return container.memoGateway.editMemo(input.userId, {
    memoId: MemoId.create(input.memoId),
    body: input.body,
    expectedVersion: input.expectedVersion,
    actor: { kind: "user", userId: input.actor.userId },
  });
}

export function memoNotFound(): NotFoundError {
  return new NotFoundError("MEMO_NOT_FOUND", "The memo was not found");
}

/**
 * Inside the DO. A `version` other than the one the editor started from is
 * answered as `conflict` without a write; the editor re-submits with
 * `conflict.currentVersion` to apply its body on top. The OCC check in
 * `save` stays as the last line, for the window this read cannot see.
 */
export function editMemoProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: EditMemoDto,
  now: Date,
): EditMemoView {
  const memoId = MemoId.create(input.memoId);
  const found = ctx.memoRepository.findById(memoId);
  if (found === null) throw memoNotFound();
  const { entity: current, expectedVersion } = found;

  if (current.version !== input.expectedVersion) {
    const latest = ctx.memoRepository.findRevision(
      memoId,
      current.latestRevisionNumber,
    );
    if (latest === null) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "The memo's latest revision is missing",
      );
    }
    return {
      result: "conflict",
      memo: toMemoView(current),
      conflict: {
        currentBody: current.body,
        currentVersion: current.version,
        latestRevision: toRevisionSummaryView(latest),
      },
    };
  }

  const actor = Actor.user(UserId.create(input.actor.userId));
  const { memo, newRevision } = Memo.edit(
    current,
    { body: input.body, actor },
    now,
  );
  if (newRevision === null) {
    return { result: "unchanged", memo: toMemoView(current), conflict: null };
  }
  ctx.memoRepository.save(memo, expectedVersion);
  ctx.memoRepository.insertRevision(newRevision);
  return { result: "saved", memo: toMemoView(memo), conflict: null };
}
