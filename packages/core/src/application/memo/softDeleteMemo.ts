import { Memo } from "@repo/core/domain/memo/entity";
import { MemoId } from "@repo/core/domain/memo/valueObject";
import { RetentionPolicy } from "@repo/core/domain/trash/retentionPolicy";
import { SystemError, SystemErrorCode } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import { armPurgeTrash } from "../trash/armPurgeTrash";
import type { ServiceArgs } from "../types";
import { memoNotFound } from "./editMemo";

export type SoftDeleteMemoInput = Readonly<{ userId: string; memoId: string }>;

/** S-TL-06, request side. */
export async function softDeleteMemo({
  container,
  input,
}: ServiceArgs<SoftDeleteMemoInput>): Promise<void> {
  await container.memoGateway.softDeleteMemo(
    input.userId,
    MemoId.create(input.memoId),
  );
}

/**
 * Inside the DO. The row moves to the trash with its deadline, the search
 * projection drops it (inside `save`), and — in the same transaction — the
 * `purge-trash` wake-up is armed (`armPurgeTrash`, one of the five
 * submission points).
 */
export function softDeleteMemoProcedure(
  ctx: UserDataUnitOfWorkContext,
  rawMemoId: string,
  now: Date,
): void {
  const memoId = MemoId.create(rawMemoId);
  const found = ctx.memoRepository.findById(memoId);
  if (found === null) throw memoNotFound();
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
  const trashed = Memo.softDelete(found.entity, purgeAfter, now);
  ctx.memoRepository.save(trashed, found.expectedVersion);

  armPurgeTrash(ctx);
}
