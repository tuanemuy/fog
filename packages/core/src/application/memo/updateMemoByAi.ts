import { Memo } from "@repo/core/domain/memo/entity";
import { MemoId } from "@repo/core/domain/memo/valueObject";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import { type AiClientActorDto, rebuildActor } from "../identity/actorDto";
import type { Needs, ServiceArgs } from "../types";
import { memoNotFound } from "./editMemo";
import type { UpdateMemoByAiDto } from "./gateway";
import type { UpdateMemoByAiView } from "./view";

export type UpdateMemoByAiInput = Readonly<{
  userId: string;
  memoId: string;
  body: string;
  actor: AiClientActorDto;
}>;

/**
 * S-AI-04 for a memo: whole-body replacement (ADR-006), applied to the
 * latest state — no `expectedVersion`, because the client has no warning
 * UI; whatever it overwrites stays in the history for the human to roll
 * back. A trashed memo does not exist here.
 */
export async function updateMemoByAi({
  container,
  input,
}: ServiceArgs<
  UpdateMemoByAiInput,
  Needs<"memoGateway">
>): Promise<UpdateMemoByAiView> {
  return container.memoGateway.updateMemoByAi(input.userId, {
    memoId: MemoId.create(input.memoId),
    body: input.body,
    actor: input.actor,
  });
}

export function updateMemoByAiProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: UpdateMemoByAiDto,
  now: Date,
): UpdateMemoByAiView {
  const found = ctx.memoRepository.findById(MemoId.create(input.memoId));
  if (found === null) throw memoNotFound();
  const { memo, newRevision } = Memo.edit(
    found.entity,
    { body: input.body, actor: rebuildActor(input.actor) },
    now,
  );
  if (newRevision === null) {
    return { result: "unchanged", memo: project(found.entity) };
  }
  ctx.memoRepository.save(memo, found.expectedVersion);
  ctx.memoRepository.insertRevision(newRevision);
  return { result: "saved", memo: project(memo) };
}

function project(memo: {
  id: string;
  body: string;
  postedAt: Date;
  latestRevisionNumber: number;
}): UpdateMemoByAiView["memo"] {
  return {
    id: memo.id,
    body: memo.body,
    postedAt: memo.postedAt,
    latestRevisionNumber: memo.latestRevisionNumber,
  };
}
