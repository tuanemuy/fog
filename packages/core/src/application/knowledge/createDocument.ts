import type { Actor } from "@repo/core/domain/identity/valueObject";
import { UserId } from "@repo/core/domain/identity/valueObject";
import { Document } from "@repo/core/domain/knowledge/entity";
import { TopicId } from "@repo/core/domain/knowledge/valueObject";
import { MemoId } from "@repo/core/domain/memo/valueObject";
import { NotFoundError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { Needs, ServiceArgs } from "../types";
import type { CreateDocumentDto } from "./gateway";
import {
  blankToNull,
  reasonOrDefault,
  rebuildActor,
  toActorDto,
  topicNotFound,
} from "./shared";
import { type CreateDocumentView, toDocumentView } from "./view";

export const CREATE_CHANGE_REASON = "作成";

export type CreateDocumentInput = Readonly<{
  userId: string;
  actor: Actor;
  topicId: string;
  title: string;
  body: string;
  sourceMemoIds: readonly string[];
  changeReason?: string | null;
}>;

/** S-DT-04 / S-AI-03, request side. Both faces, so `Actor` stays wide. */
export async function createDocument({
  container,
  input,
}: ServiceArgs<
  CreateDocumentInput,
  Needs<"knowledgeGateway">
>): Promise<CreateDocumentView> {
  return container.knowledgeGateway.createDocument(input.userId, {
    actor: toActorDto(input.actor),
    topicId: input.topicId,
    title: input.title,
    body: input.body,
    sourceMemoIds: input.sourceMemoIds,
    changeReason: blankToNull(input.changeReason),
  });
}

/**
 * Inside the DO. The topic is read with its OCC token and touched
 * (`version` + 1, content unchanged) so that a writer holding an older
 * token across a transaction sees the conflict; the sources are checked
 * as a set — one missing or trashed memo fails the whole creation. Then
 * the row, revision #1 and the links, with the projection inside
 * `insertSourceLinks`.
 */
export function createDocumentProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: CreateDocumentDto & { userId: string },
  ids: { documentId: string; revisionId: string },
  now: Date,
): CreateDocumentView {
  const topicId = TopicId.create(input.topicId);
  const topic = ctx.topicRepository.findById(topicId);
  if (topic === null) throw topicNotFound();

  const memoIds = [...new Set(input.sourceMemoIds)].map((id) =>
    MemoId.create(id),
  );
  if (memoIds.length > 0) {
    const active = new Set(
      ctx.memoRepository.listActiveByIds(memoIds).map((m) => m.entity.id),
    );
    if (memoIds.some((id) => !active.has(id))) {
      throw new NotFoundError("MEMO_NOT_FOUND", "A source memo was not found");
    }
  }

  const { document, revision, sourceLinks } = Document.create(
    {
      id: ids.documentId,
      revisionId: ids.revisionId,
      userId: UserId.create(input.userId),
      topicId,
      title: input.title,
      body: input.body,
      actor: rebuildActor(input.actor),
      changeReason: reasonOrDefault(input.changeReason, CREATE_CHANGE_REASON),
      sourceMemoIds: memoIds,
    },
    now,
  );
  ctx.topicRepository.save(
    { ...topic.entity, version: topic.entity.version + 1 },
    topic.expectedVersion,
  );
  ctx.documentRepository.insert(document);
  ctx.documentRepository.insertRevision(revision);
  ctx.documentRepository.insertSourceLinks(sourceLinks);
  return {
    ...toDocumentView(document),
    sourceMemoIds: sourceLinks.map((link) => link.memoId),
  };
}
