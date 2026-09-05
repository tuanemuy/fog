import { searchPosition, searchQuery } from "@repo/core/domain/fog/data";
import {
  type ContentDependencies,
  found,
  requireHuman,
} from "./contentSupport";
import type { DataServices } from "./dataTypes";

export function createSearchServices({
  unitOfWork,
  clock,
}: ContentDependencies): Pick<DataServices, "search" | "exportData"> {
  return {
    async search(actor, input) {
      const query = searchQuery(input.query);
      if (!query) return { items: [], nextCursor: null };
      const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 30)));
      const scope = `${encodeURIComponent(query)}|${encodeURIComponent(input.topicId ?? "")}`;
      const before = input.cursor
        ? searchPosition(input.cursor, scope)
        : undefined;
      return unitOfWork.run(async (context) => {
        if (input.topicId)
          found(
            await context.topics(actor.userId).find(input.topicId),
            "TOPIC",
          );
        const repo = context.data(actor.userId);
        const rows = await repo.search({
          query,
          limit: limit + 1,
          ...(input.topicId ? { topicId: input.topicId } : {}),
          ...(before ? { before } : {}),
        });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        const items = await Promise.all(
          page.map(async ({ body, ...row }) => {
            const index = body.toLowerCase().indexOf(query.toLowerCase());
            const start = Math.max(0, index - 50);
            return {
              ...row,
              snippet: body.slice(start, start + 200),
              sourceIds: await repo.sourceIds(row),
            };
          }),
        );
        return {
          items,
          nextCursor:
            rows.length > limit && last
              ? `${last.createdAt}|${last.id}|${last.kind}|${scope}`
              : null,
        };
      });
    },
    async exportData(actor) {
      requireHuman(actor);
      return unitOfWork.run(async (context) => {
        const topics = (await context.topics(actor.userId).list()).map(
          ({ ownerId: _, version: __, ...topic }) => topic,
        );
        const memos = (await context.memos(actor.userId).list()).map(
          ({ ownerId: _, version: __, ...memo }) => memo,
        );
        const repo = context.documents(actor.userId);
        const documents = (
          await Promise.all(
            topics.map(async (topic) =>
              Promise.all(
                (
                  await repo.list(topic.id)
                ).map(async ({ ownerId: _, version: __, ...document }) => ({
                  ...document,
                  sourceMemoIds: await context
                    .data(actor.userId)
                    .sourceIds({ kind: "document", id: document.id }),
                })),
              ),
            ),
          )
        ).flat();
        return {
          format: "fog-export",
          version: 1,
          exportedAt: clock.now().toISOString(),
          memos,
          topics,
          documents,
        };
      });
    },
  };
}
