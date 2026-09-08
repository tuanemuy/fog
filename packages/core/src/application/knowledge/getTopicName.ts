import { TopicId } from "@repo/core/domain/knowledge/valueObject";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import { topicNotFound } from "./shared";
import type { TopicNameView } from "./view";

export type GetTopicNameInput = Readonly<{ userId: string; topicId: string }>;

/** P-08's topic link and P-09's way back: one summary read, nothing else. */
export async function getTopicName({
  container,
  input,
}: ServiceArgs<GetTopicNameInput>): Promise<TopicNameView> {
  return container.knowledgeGateway.getTopicName(input.userId, input.topicId);
}

export function getTopicNameProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawTopicId: string,
): TopicNameView {
  const topicId = TopicId.create(rawTopicId);
  const summary = ctx.topicRepository.listSummariesByIds([topicId])[0];
  if (summary === undefined) throw topicNotFound();
  return { topicId: summary.id, name: summary.name };
}
