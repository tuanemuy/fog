import { type LiveTopic, Topic } from "@repo/core/domain/knowledge/entity";
import { TopicId } from "@repo/core/domain/knowledge/valueObject";
import { ValidationError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { UpdateTopicDto } from "./gateway";
import { topicNotFound } from "./shared";
import { type TopicView, toTopicView } from "./view";

export type UpdateTopicInput = Readonly<{
  userId: string;
  topicId: string;
  name?: string;
  description?: string | null;
  archived?: boolean;
}>;

/** S-DT-03 / S-AI-06, request side. An update that changes nothing is refused here. */
export async function updateTopic({
  container,
  input,
}: ServiceArgs<UpdateTopicInput>): Promise<TopicView> {
  if (
    input.name === undefined &&
    input.description === undefined &&
    input.archived === undefined
  ) {
    throw new ValidationError(
      "NO_CHANGES",
      "name, description or archived must be given",
    );
  }
  const dto: { -readonly [K in keyof UpdateTopicDto]: UpdateTopicDto[K] } = {
    topicId: input.topicId,
  };
  if (input.name !== undefined) dto.name = input.name;
  if (input.description !== undefined) dto.description = input.description;
  if (input.archived !== undefined) dto.archived = input.archived;
  return container.knowledgeGateway.updateTopic(input.userId, dto);
}

/**
 * Inside the DO. The behaviours compose in order; an `archived` equal to
 * the current state applies nothing, and `save` still runs (the version
 * moves, as the testcases say).
 */
export function updateTopicProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: UpdateTopicDto,
  now: Date,
): TopicView {
  const found = ctx.topicRepository.findById(TopicId.create(input.topicId));
  if (found === null) throw topicNotFound();
  let topic: LiveTopic = found.entity;
  if (input.name !== undefined) topic = Topic.rename(topic, input.name, now);
  if (input.description !== undefined) {
    topic = Topic.changeDescription(topic, input.description, now);
  }
  if (input.archived === true && topic.status === "active") {
    topic = Topic.archive(topic, now);
  } else if (input.archived === false && topic.status === "archived") {
    topic = Topic.unarchive(topic, now);
  }
  if (topic === found.entity) {
    topic = { ...topic, version: topic.version + 1, updatedAt: now };
  }
  ctx.topicRepository.save(topic, found.expectedVersion);
  return toTopicView(topic);
}
