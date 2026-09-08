import { UserId } from "@repo/core/domain/identity/valueObject";
import { Topic } from "@repo/core/domain/knowledge/entity";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { Needs, ServiceArgs } from "../types";
import type { CreateTopicDto } from "./gateway";
import { type TopicView, toTopicView } from "./view";

export type CreateTopicInput = Readonly<{
  userId: string;
  name: string;
  description?: string | null;
}>;

/** S-DT-01, request side. Both faces (UI / `create_topic`). */
export async function createTopic({
  container,
  input,
}: ServiceArgs<
  CreateTopicInput,
  Needs<"knowledgeGateway">
>): Promise<TopicView> {
  return container.knowledgeGateway.createTopic(input.userId, {
    name: input.name,
    description: input.description ?? null,
  });
}

/** Inside the DO. A topic has no search entry, so nothing is projected. */
export function createTopicProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: CreateTopicDto & { userId: string },
  id: string,
  now: Date,
): TopicView {
  const topic = Topic.create(
    {
      id,
      userId: UserId.create(input.userId),
      name: input.name,
      description: input.description,
    },
    now,
  );
  ctx.topicRepository.insert(topic);
  return toTopicView(topic);
}
