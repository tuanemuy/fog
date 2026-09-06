import { BusinessRuleError } from "@repo/core/domain/error";
import { contentTitle, topicDescription } from "@repo/core/domain/fog/content";
import { retentionPeriod } from "@repo/core/domain/fog/data";
import { ConflictError, NotFoundError } from "../errors";
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
export const TRASH_DELETE_ROW_LIMIT = 100;
export const EMPTY_TRASH_MAX_TRANSACTIONS = 40;
export const RETENTION_OWNER_PAGE_SIZE = 25;
export const RETENTION_MAX_TRANSACTIONS_PER_OWNER = 4;
async function deleted(repo: DataRepository, ref: ContentRef) {
  const item = await repo.findTrash(ref);
  if (!item)
    throw new NotFoundError(
      "TRASH_NOT_FOUND",
      "ゴミ箱の項目が見つかりません。",
    );
  return item;
}
const purgeConflict = () =>
  new ConflictError(
    "PURGE_IN_PROGRESS",
    "完全削除を開始した項目は復元できません。",
  );
export function createTrashServices({
  unitOfWork,
  clock,
  ids,
  trashBatchPolicy,
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
        const counts = await repo.trashCount();
        const now = clock.now().getTime();
        return {
          retentionDays,
          purgingCount: counts.purgingCount,
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
        if (item.purging) throw purgeConflict();
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
        if (item.topic.kind === "purging") throw purgeConflict();
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
      const initialCount = await unitOfWork.read(async (context) => {
        const repo = context.data(actor.userId);
        await deleted(repo, input);
        return repo.purgeTargetCount(input);
      });
      const rowLimit = trashBatchPolicy?.rowLimit ?? TRASH_DELETE_ROW_LIMIT;
      const maxTransactions =
        trashBatchPolicy?.maxTransactions ?? EMPTY_TRASH_MAX_TRANSACTIONS;
      for (let batch = 0; batch < maxTransactions; batch++) {
        const result = await unitOfWork.run((context) =>
          context.data(actor.userId).deleteTrashBatch({
            limitPerKind: rowLimit,
            target: input,
          }),
        );
        if (result.processedRowCount === 0) break;
      }
      const { active, remainingCount } = await unitOfWork.read(
        async (context) => {
          const repo = context.data(actor.userId);
          return {
            active: await repo.isPurgeTargetActive(input),
            remainingCount: await repo.purgeTargetCount(input),
          };
        },
      );
      if (active)
        throw new ConflictError(
          "OPTIMISTIC_LOCK_FAILURE",
          "項目の状態が変更されました。最新の内容を確認してください。",
        );
      return {
        status: remainingCount === 0 ? "complete" : "partial",
        deletedCount: Math.max(initialCount - remainingCount, 0),
        remainingCount,
      };
    },
    async emptyTrash(actor) {
      requireHuman(actor);
      const rowLimit = trashBatchPolicy?.rowLimit ?? TRASH_DELETE_ROW_LIMIT;
      const maxTransactions =
        trashBatchPolicy?.maxTransactions ?? EMPTY_TRASH_MAX_TRANSACTIONS;
      let deletedCount = 0;
      for (let batch = 0; batch < maxTransactions; batch++) {
        const result = await unitOfWork.run((context) =>
          context.data(actor.userId).deleteTrashBatch({
            limitPerKind: rowLimit,
          }),
        );
        deletedCount += result.deletedCount;
        if (result.processedRowCount === 0) break;
      }
      const counts = await unitOfWork.read((context) =>
        context.data(actor.userId).trashCount(),
      );
      const remainingCount = counts.restorableCount + counts.purgingCount;
      return {
        status: remainingCount === 0 ? "complete" : "partial",
        deletedCount,
        remainingCount,
      };
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
export async function purgeExpiredTrash({
  unitOfWork,
  clock,
}: {
  unitOfWork: FogUnitOfWorkProvider;
  clock: Clock;
}): Promise<{ deletedCount: number }> {
  const now = clock.now().getTime();
  let deletedCount = 0;
  let afterId: string | undefined;
  while (true) {
    const owners = await unitOfWork.read((context) =>
      context.retentionOwners({
        ...(afterId ? { afterId } : {}),
        limit: RETENTION_OWNER_PAGE_SIZE,
      }),
    );
    for (const owner of owners) {
      const deletedBefore = new Date(
        now - owner.retentionDays * DAY,
      ).toISOString();
      for (
        let batch = 0;
        batch < RETENTION_MAX_TRANSACTIONS_PER_OWNER;
        batch++
      ) {
        const result = await unitOfWork.run((context) =>
          context.data(owner.id).deleteTrashBatch({
            deletedBefore,
            limitPerKind: TRASH_DELETE_ROW_LIMIT,
          }),
        );
        deletedCount += result.deletedCount;
        if (result.processedRowCount === 0) break;
      }
    }
    if (owners.length < RETENTION_OWNER_PAGE_SIZE) break;
    afterId = owners.at(-1)?.id;
    if (!afterId) break;
  }
  return { deletedCount };
}
