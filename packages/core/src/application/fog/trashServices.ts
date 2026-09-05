import { BusinessRuleError } from "@repo/core/domain/error";
import { contentTitle, topicDescription } from "@repo/core/domain/fog/content";
import { retentionPeriod } from "@repo/core/domain/fog/data";
import { NotFoundError } from "../errors";
import type { Clock } from "../ports/clock";
import {
  type ContentDependencies,
  found,
  requireHuman,
  requireVersion,
} from "./contentSupport";
import type { ContentRef, DataServices } from "./dataTypes";
import type { DataRepository, FogUnitOfWorkProvider } from "./ports";

const DAY = 86_400_000;
async function deleted(repo: DataRepository, ref: ContentRef) {
  const item = await repo.findTrash(ref);
  if (!item)
    throw new NotFoundError(
      "TRASH_NOT_FOUND",
      "ゴミ箱の項目が見つかりません。",
    );
  return item;
}
export function createTrashServices({
  unitOfWork,
  clock,
  ids,
}: ContentDependencies): Pick<
  DataServices,
  | "softDelete"
  | "trash"
  | "restore"
  | "hardDelete"
  | "emptyTrash"
  | "getSettings"
  | "setRetentionDays"
> {
  return {
    async softDelete(actor, input) {
      await unitOfWork.run(async (context) => {
        const current =
          input.kind === "memo"
            ? found(await context.memos(actor.userId).find(input.id), "MEMO")
            : input.kind === "document"
              ? found(
                  await context.documents(actor.userId).find(input.id),
                  "DOCUMENT",
                )
              : found(
                  await context.topics(actor.userId).find(input.id),
                  "TOPIC",
                );
        requireVersion(current.version, input.expectedVersion);
        await context
          .data(actor.userId)
          .softDelete(
            input,
            input.expectedVersion,
            clock.now().toISOString(),
            ids.next(),
          );
      });
    },
    async trash(actor) {
      requireHuman(actor);
      return unitOfWork.run(async (context) => {
        const repo = context.data(actor.userId);
        const retentionDays = await repo.retentionDays();
        const now = clock.now().getTime();
        return {
          retentionDays,
          items: (await repo.trash()).map((item) => ({
            ...item,
            remainingDays: Math.max(
              0,
              Math.ceil(
                (Date.parse(item.deletedAt) + retentionDays * DAY - now) / DAY,
              ),
            ),
          })),
        };
      });
    },
    async restore(actor, input) {
      requireHuman(actor);
      await unitOfWork.run(async (context) => {
        const repo = context.data(actor.userId);
        const item = await deleted(repo, input);
        if (item.kind !== "document") {
          await repo.restore(input);
          return;
        }
        if (item.topic.kind === "deleted") {
          if (!input.restoreTopicSet)
            throw new BusinessRuleError(
              "TOPIC_RESTORE_CONFIRMATION_REQUIRED",
              "所属トピックとセットの文書も復元されます。確認してください。",
            );
          await repo.restore({ kind: "topic", id: item.topic.id });
          if (await repo.findTrash(input))
            await repo.restore(input, item.topic.id);
          return;
        }
        if (item.topic.kind === "active") {
          await repo.restore(input, item.topic.id);
          return;
        }
        const destination = input.targetTopic;
        if (!destination)
          throw new BusinessRuleError(
            "RESTORE_TOPIC_REQUIRED",
            "復元先のトピックを選択してください。",
          );
        if (destination.kind === "existing") {
          const topic = found(
            await context.topics(actor.userId).find(destination.id),
            "TOPIC",
          );
          await repo.restore(input, topic.id);
          return;
        }
        const title = contentTitle(destination.title);
        const description = topicDescription(destination.description);
        const now = clock.now().toISOString();
        const id = ids.next();
        await context.topics(actor.userId).create({
          id,
          ownerId: actor.userId,
          title,
          description,
          completed: false,
          createdAt: now,
          updatedAt: now,
          version: 1,
        });
        await repo.restore(input, id);
      });
    },
    async hardDelete(actor, input) {
      requireHuman(actor);
      await unitOfWork.run(async (context) => {
        const repo = context.data(actor.userId);
        await deleted(repo, input);
        await repo.hardDelete(input);
      });
    },
    async emptyTrash(actor) {
      requireHuman(actor);
      await unitOfWork.run(async (context) => {
        const repo = context.data(actor.userId);
        for (const item of await repo.trash()) await repo.hardDelete(item);
      });
    },
    async getSettings(actor) {
      requireHuman(actor);
      return unitOfWork.run(async (context) => ({
        retentionDays: await context.data(actor.userId).retentionDays(),
      }));
    },
    async setRetentionDays(actor, input) {
      requireHuman(actor);
      const days = retentionPeriod(input.retentionDays);
      return unitOfWork.run(async (context) => {
        await context.data(actor.userId).setRetentionDays(days);
        return { retentionDays: days };
      });
    },
  };
}

/** Applies each owner's current retention period without requiring a user session. */
export function purgeExpiredTrash({
  unitOfWork,
  clock,
}: {
  unitOfWork: FogUnitOfWorkProvider;
  clock: Clock;
}): Promise<{ deletedCount: number }> {
  const now = clock.now().getTime();
  return unitOfWork.run(async (context) => {
    let deletedCount = 0;
    for (const owner of await context.retentionOwners()) {
      const repo = context.data(owner.id);
      for (const item of await repo.trash())
        if (Date.parse(item.deletedAt) + owner.retentionDays * DAY <= now)
          deletedCount += await repo.hardDelete(item);
    }
    return { deletedCount };
  });
}
