import {
  contentTitle,
  documentBody,
  revisionReason,
} from "@repo/core/domain/fog/content";
import {
  type ContentDependencies,
  documentView,
  found,
  requireHuman,
  requireVersion,
} from "./contentSupport";
import type { DocumentServices } from "./types";
export function createDocumentServices({
  unitOfWork,
  clock,
  ids,
}: ContentDependencies): DocumentServices {
  return {
    async createDocument(actor, input) {
      const title = contentTitle(input.title);
      const body = documentBody(input.body);
      const reason = revisionReason(actor, input.reason, "新規作成");
      const now = clock.now().toISOString();
      const document = {
        id: ids.next(),
        ownerId: actor.userId,
        topicId: input.topicId,
        title,
        body,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      return unitOfWork.run(async (context) => {
        found(await context.topics(actor.userId).find(input.topicId), "TOPIC");
        const sourceIds = [...new Set(input.sourceMemoIds)];
        for (const id of sourceIds)
          found(await context.memos(actor.userId).find(id), "MEMO");
        await context
          .documents(actor.userId)
          .create(document, sourceIds, actor, reason);
        return documentView(context, document, actor);
      });
    },
    async getDocument(actor, id) {
      return unitOfWork.run(async (context) =>
        documentView(
          context,
          found(await context.documents(actor.userId).find(id), "DOCUMENT"),
          actor,
        ),
      );
    },
    async editDocument(actor, input) {
      const title = contentTitle(input.title);
      const body = documentBody(input.body);
      const reason = revisionReason(actor, input.reason, "手動編集");
      return unitOfWork.run(async (context) => {
        const repo = context.documents(actor.userId);
        const current = found(await repo.find(input.id), "DOCUMENT");
        requireVersion(current.version, input.expectedVersion);
        if (current.title === title && current.body === body)
          return documentView(context, current, actor);
        const updated = {
          ...current,
          title,
          body,
          updatedAt: clock.now().toISOString(),
          version: current.version + 1,
        };
        await repo.update(updated, input.expectedVersion, actor, reason);
        return documentView(context, updated, actor);
      });
    },
    async documentHistory(actor, id) {
      requireHuman(actor);
      return unitOfWork.run(async (context) => {
        const repo = context.documents(actor.userId);
        found(await repo.find(id), "DOCUMENT");
        return repo.history(id);
      });
    },
    async rollbackDocument(actor, input) {
      requireHuman(actor);
      return unitOfWork.run(async (context) => {
        const repo = context.documents(actor.userId);
        const current = found(await repo.find(input.id), "DOCUMENT");
        requireVersion(current.version, input.expectedVersion);
        const revision = found(
          (await repo.history(input.id)).find(
            (rev) => rev.version === input.version,
          ) ?? null,
          "REVISION",
        );
        const updated = {
          ...current,
          title: revision.title,
          body: revision.body,
          updatedAt: clock.now().toISOString(),
          version: current.version + 1,
        };
        await repo.update(
          updated,
          input.expectedVersion,
          actor,
          `リビジョン ${input.version} に復元`,
        );
        return documentView(context, updated, actor);
      });
    },
  };
}
