import { TopicTrashService } from "@repo/core/domain/knowledge/service";
import { TopicId } from "@repo/core/domain/knowledge/valueObject";
import { RetentionPolicy } from "@repo/core/domain/trash/retentionPolicy";
import { SystemError, SystemErrorCode } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import { armPurgeTrash } from "../trash/armPurgeTrash";
import type { Needs, ServiceArgs } from "../types";
import { topicNotFound } from "./shared";
import type { TrashTopicView } from "./view";

export type TrashTopicInput = Readonly<{ userId: string; topicId: string }>;

/** S-DT-09 / S-AI-05, request side. */
export async function trashTopic({
  container,
  input,
}: ServiceArgs<
  TrashTopicInput,
  Needs<"knowledgeGateway">
>): Promise<TrashTopicView> {
  return container.knowledgeGateway.trashTopic(input.userId, input.topicId);
}

/**
 * Inside the DO. The topic and its active documents go to the trash as one
 * set (`trashedWith`), each document's `save` dropping its entry and
 * re-projecting its source memos, and the purge wake-up is armed — all in
 * the one transaction.
 */
export function trashTopicProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawTopicId: string,
  now: Date,
): TrashTopicView {
  const topicId = TopicId.create(rawTopicId);
  const found = ctx.topicRepository.findById(topicId);
  if (found === null) throw topicNotFound();
  const documents = ctx.documentRepository.listActiveByTopic(topicId);
  const settings = ctx.userSettingsRepository.find();
  if (settings === null) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "The account holds no settings row",
    );
  }
  const purgeAfter = RetentionPolicy.expiresAt(
    now,
    settings.entity.trashRetentionDays,
  );
  const set = TopicTrashService.trashTopicSet(
    found.entity,
    documents.map((document) => document.entity),
    purgeAfter,
    now,
  );
  ctx.topicRepository.save(set.topic, found.expectedVersion);
  set.documents.forEach((document, index) => {
    const token = documents[index]?.expectedVersion;
    if (token === undefined) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "trashTopic: a document lost its OCC token between read and save",
      );
    }
    ctx.documentRepository.save(document, token);
  });
  armPurgeTrash(ctx);
  return {
    topicId,
    trashedDocumentIds: set.documents.map((document) => document.id),
  };
}
