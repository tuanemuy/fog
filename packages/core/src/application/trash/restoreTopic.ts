import { TopicTrashService } from "@repo/core/domain/knowledge/service";
import { TopicId } from "@repo/core/domain/knowledge/valueObject";
import { NotFoundError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { RestoreTopicView } from "./view";

export type RestoreTopicInput = Readonly<{ userId: string; topicId: string }>;

/** S-TR-02 (topic), request side. */
export async function restoreTopic({
  container,
  input,
}: ServiceArgs<RestoreTopicInput>): Promise<RestoreTopicView> {
  return container.trashGateway.restoreTopic(input.userId, input.topicId);
}

/**
 * Inside the DO. The topic comes back to the state it had (active or
 * archived) with the documents trashed together with it; documents deleted
 * on their own stay in the trash.
 */
export function restoreTopicProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawTopicId: string,
  now: Date,
): RestoreTopicView {
  const topicId = TopicId.create(rawTopicId);
  const found = ctx.topicRepository.findByIdIncludingTrashed(topicId);
  if (found === null || found.entity.status !== "trashed") {
    throw new NotFoundError("TOPIC_NOT_FOUND", "The topic is not in the trash");
  }
  const trashed = ctx.documentRepository.listTrashedByTopic(topicId);
  const outcome = TopicTrashService.restoreTopicSet(
    found.entity,
    trashed.map((d) => d.entity),
    now,
  );
  ctx.topicRepository.save(outcome.topic, found.expectedVersion);
  const versions = new Map(
    trashed.map((d) => [d.entity.id, d.expectedVersion]),
  );
  for (const document of outcome.restoredDocuments) {
    ctx.documentRepository.save(
      document,
      versions.get(document.id) as (typeof trashed)[number]["expectedVersion"],
    );
  }
  return {
    topicId,
    restoredDocumentIds: outcome.restoredDocuments.map((d) => d.id),
  };
}
