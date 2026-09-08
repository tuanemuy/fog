import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { ListTopicsDto } from "./gateway";
import {
  type TopicListView,
  type TopicWithDocumentsView,
  toTopicDocumentRowView,
  toTopicView,
} from "./view";

export type ListTopicsInput = Readonly<{
  userId: string;
  includeArchived: boolean;
}>;

/** S-DT-02 / S-AI-02, request side. */
export async function listTopics({
  container,
  input,
}: ServiceArgs<ListTopicsInput>): Promise<TopicListView> {
  return container.knowledgeGateway.listTopics(input.userId, {
    includeArchived: input.includeArchived,
  });
}

/** Inside the DO. One query for the topics, one for all their documents. */
export function listTopicsProcedure(
  ctx: UserDataUnitOfWorkContext,
  input: ListTopicsDto,
): TopicListView {
  const topics = ctx.topicRepository.listByUser({
    includeArchived: input.includeArchived,
  });
  const documents = ctx.documentRepository.listActiveSummariesByTopics(
    topics.map((topic) => topic.id),
  );
  const byTopic = new Map<
    string,
    TopicWithDocumentsView["documents"][number][]
  >();
  for (const summary of documents) {
    const rows = byTopic.get(summary.topicId) ?? [];
    rows.push(toTopicDocumentRowView(summary));
    byTopic.set(summary.topicId, rows);
  }
  return {
    topics: topics.map((topic) => ({
      ...toTopicView(topic),
      documents: byTopic.get(topic.id) ?? [],
    })),
  };
}
