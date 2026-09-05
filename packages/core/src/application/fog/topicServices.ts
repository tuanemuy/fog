import { contentTitle, topicDescription } from "@repo/core/domain/fog/content";
import {
  type ContentDependencies,
  documentView,
  found,
  memoView,
  requireVersion,
} from "./contentSupport";
import type { TopicServices } from "./types";
export function createTopicServices({
  unitOfWork,
  clock,
  ids,
}: ContentDependencies): TopicServices {
  return {
    listTopics(actor) {
      return unitOfWork.run(async (context) =>
        (await context.topics(actor.userId).list()).map(
          ({ ownerId: _, ...topic }) => topic,
        ),
      );
    },
    async getTopic(actor, id) {
      return unitOfWork.run(async (context) => {
        const { ownerId: _, ...topic } = found(
          await context.topics(actor.userId).find(id),
          "TOPIC",
        );
        const repo = context.documents(actor.userId);
        return {
          topic,
          documents: await Promise.all(
            (await repo.list(id)).map((doc) =>
              documentView(context, doc, actor),
            ),
          ),
          relatedMemos: await Promise.all(
            (await repo.relatedMemos(id)).map((memo) =>
              memoView(context, memo, actor),
            ),
          ),
        };
      });
    },
    async createTopic(actor, input) {
      const title = contentTitle(input.title);
      const description = topicDescription(input.description);
      const now = clock.now().toISOString();
      const topic = {
        id: ids.next(),
        title,
        description,
        completed: false,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      return unitOfWork.run(async (context) => {
        await context
          .topics(actor.userId)
          .create({ ...topic, ownerId: actor.userId });
        return topic;
      });
    },
    async updateTopic(actor, input) {
      const title = contentTitle(input.title);
      const description = topicDescription(input.description);
      return unitOfWork.run(async (context) => {
        const repo = context.topics(actor.userId);
        const current = found(await repo.find(input.id), "TOPIC");
        requireVersion(current.version, input.expectedVersion);
        const changed =
          current.title !== title ||
          current.description !== description ||
          current.completed !== input.completed;
        const updated = changed
          ? {
              ...current,
              title,
              description,
              completed: input.completed,
              updatedAt: clock.now().toISOString(),
              version: current.version + 1,
            }
          : current;
        if (changed) await repo.update(updated, input.expectedVersion);
        const { ownerId: _, ...view } = updated;
        return view;
      });
    },
  };
}
