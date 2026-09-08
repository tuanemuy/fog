import { User } from "@repo/core/domain/identity/entity";
import { TrashRetentionDays } from "@repo/core/domain/identity/valueObject";
import { NotFoundError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import { armPurgeTrash } from "../trash/armPurgeTrash";
import type { PruneBudget } from "../trash/pruneExpiredTrashItems";
import type { ServiceArgs } from "../types";

export type ChangeTrashRetentionDaysInput = Readonly<{
  userId: string;
  retentionDays: number;
}>;

/** S-ST-01, request side. */
export async function changeTrashRetentionDays({
  container,
  input,
}: ServiceArgs<ChangeTrashRetentionDaysInput>): Promise<void> {
  await container.identityGateway.changeTrashRetentionDays(
    input.userId,
    input.retentionDays,
  );
}

/**
 * Inside the DO, one transaction: the setting, then every trashed row's
 * `purge_after` under the wake-up-sized chunk budget (what is left is the
 * self-consuming predicate the `purge-trash` job finishes), then the
 * wake-up on the new earliest deadline. An empty trash arms nothing.
 */
export function changeTrashRetentionDaysProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawDays: number,
  now: Date,
  budget: PruneBudget,
): void {
  const days = TrashRetentionDays.create(rawDays);
  const found = ctx.userSettingsRepository.find();
  if (found === null) {
    throw new NotFoundError("USER_NOT_FOUND", "The user was not found");
  }
  ctx.userSettingsRepository.save(
    User.changeTrashRetentionDays(found.entity, days, now),
    found.expectedVersion,
  );
  for (let n = 0; n < budget.maxChunks; n += 1) {
    const memos = ctx.memoRepository.recalculatePurgeAfter(
      days,
      budget.chunkLimit,
    );
    const topics = ctx.topicRepository.recalculatePurgeAfter(
      days,
      budget.chunkLimit,
    );
    const documents = ctx.documentRepository.recalculatePurgeAfter(
      days,
      budget.chunkLimit,
    );
    if (!(memos.hasMore || topics.hasMore || documents.hasMore)) break;
  }
  if (ctx.trashQueryPort.findEarliestPurgeAfter() !== null) armPurgeTrash(ctx);
}
