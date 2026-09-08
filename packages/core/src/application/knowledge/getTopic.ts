import { TopicId } from "@repo/core/domain/knowledge/valueObject";
import { snippetOf } from "@repo/core/lib/text";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import { topicNotFound } from "./shared";
import {
  type RelatedMemoView,
  type TopicDetailView,
  toTopicDocumentRowView,
  toTopicView,
} from "./view";

export type GetTopicInput = Readonly<{ userId: string; topicId: string }>;

/** S-DT-02, request side (human UI only: reads the trash for 「削除済み」). */
export async function getTopic({
  container,
  input,
}: ServiceArgs<GetTopicInput>): Promise<TopicDetailView> {
  return container.knowledgeGateway.getTopic(input.userId, input.topicId);
}

/**
 * Inside the DO. The related memos are the union of the documents' sources,
 * read with two bulk queries (links by documents, memos by ids).
 */
export function getTopicProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawTopicId: string,
): TopicDetailView {
  const topicId = TopicId.create(rawTopicId);
  const found = ctx.topicRepository.findById(topicId);
  if (found === null) throw topicNotFound();
  const documents = ctx.documentRepository.listActiveSummariesByTopic(topicId);
  const links = ctx.documentRepository.listSourceLinksByDocuments(
    documents.map((document) => document.id),
  );
  const memoIds = [...new Set(links.map((link) => link.memoId))];
  const memos = ctx.memoRepository.listByIdsIncludingTrashed(memoIds);
  const relatedMemos: RelatedMemoView[] = memos
    .map((memo) => ({
      memoId: memo.id as string,
      snippet: snippetOf(memo.body),
      postedAt: memo.postedAt,
      deleted: memo.status === "trashed",
    }))
    .sort(
      (a, b) =>
        b.postedAt.getTime() - a.postedAt.getTime() ||
        b.memoId.localeCompare(a.memoId),
    );
  return {
    topic: toTopicView(found.entity),
    documents: documents.map(toTopicDocumentRowView),
    relatedMemos,
  };
}
