import type { UserActor } from "@repo/core/domain/identity/valueObject";
import { Memo } from "@repo/core/domain/memo/entity";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import { rebuildActor } from "../identity/actorDto";
import type { ServiceArgs } from "../types";
import type { PostMemoDto } from "./gateway";
import { type MemoView, toMemoView } from "./view";

export type PostMemoInput = Readonly<{
  userId: string;
  body: string;
  /** Only a human may post through this face; the AI side is `post_memo`. */
  actor: UserActor;
}>;

export type PostMemoOutput = Readonly<{ memo: MemoView }>;

/** S-TL-01, request side: hands the primitives to the user's Durable Object. */
export async function postMemo({
  container,
  input,
}: ServiceArgs<PostMemoInput>): Promise<PostMemoOutput> {
  const memo = await container.memoGateway.postMemo(input.userId, {
    body: input.body,
    actor: { kind: "user", userId: input.actor.userId },
  });
  return { memo };
}

/**
 * S-TL-01 inside the DO: the memo, its first revision and the search
 * projection land in one transaction. `id` and `now` are resolved by the
 * caller from the DO's own ports.
 */
export function postMemoProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: PostMemoDto & { userId: string },
  id: string,
  now: Date,
): MemoView {
  const actor = rebuildActor(input.actor);
  const { memo, initialRevision } = Memo.create(
    { id, userId: input.userId, body: input.body, actor },
    now,
  );
  ctx.memoRepository.insert(memo);
  ctx.memoRepository.insertRevision(initialRevision);
  return toMemoView(memo);
}
