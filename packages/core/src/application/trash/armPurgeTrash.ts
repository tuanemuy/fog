import { SystemError, SystemErrorCode } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";

/** `jobs.operation_key` of the one `purge-trash` row a User Data DO holds. */
export const PURGE_TRASH_OPERATION_KEY = "purge-trash";

/**
 * Arms the `purge-trash` wake-up on the earliest deadline in the trash, in
 * the same transaction as the soft delete that just added to it
 * (`spec/domains/trash.md`, 保持期限 手順 2). `enqueueJob` only ever moves a
 * runnable row earlier and revives a `done` one, so submitting
 * unconditionally is the "only if earlier" the spec asks for. Every soft
 * delete and the retention change call this — it is the only way the job
 * comes back from a `done` — so leaving one call site out would strand
 * the purge after its first empty run.
 */
export function armPurgeTrash(ctx: UserDataUnitOfWorkContext): void {
  const earliest = ctx.trashQueryPort.findEarliestPurgeAfter();
  if (earliest === null) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "The trash reads as empty right after a soft delete",
    );
  }
  ctx.enqueueJob({
    operationKey: PURGE_TRASH_OPERATION_KEY,
    kind: "purge-trash",
    payload: {},
    nextRunAt: earliest,
  });
}
