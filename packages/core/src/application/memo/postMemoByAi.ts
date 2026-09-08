import type { AiClientActorDto } from "../identity/actorDto";
import type { Needs, ServiceArgs } from "../types";
import type { AiMemoView } from "./view";

export type PostMemoByAiInput = Readonly<{
  userId: string;
  body: string;
  /** Resolved from the token by the authorization middleware. */
  actor: AiClientActorDto;
}>;

export type PostMemoByAiOutput = Readonly<{ memo: AiMemoView }>;

/** S-AI-01: the same write as `postMemo`, the revision's 「誰が」 being the client. */
export async function postMemoByAi({
  container,
  input,
}: ServiceArgs<
  PostMemoByAiInput,
  Needs<"memoGateway">
>): Promise<PostMemoByAiOutput> {
  const memo = await container.memoGateway.postMemo(input.userId, {
    body: input.body,
    actor: input.actor,
  });
  return { memo: { id: memo.id, body: memo.body, postedAt: memo.postedAt } };
}
