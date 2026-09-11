import { AiClientConnection } from "@repo/core/domain/identity/entity";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import { WITHDRAWAL_OPERATION_ID } from "./jobKeys";

/**
 * The last transaction of `finalize-withdrawal` (`spec/recovery/index.md`):
 * the reverse index is emptied, every active AI connection is revoked, the
 * account becomes the tombstone and the withdrawal record closes — all
 * through the unit of work's own doors. `oauth_consumed_codes` is
 * adapter-owned and stays the job's to clear in the same transaction.
 */
export function finishWithdrawalProcedure(
  ctx: UserDataUnitOfWorkContext,
  now: Date,
): void {
  const credentialIds = new Set(
    ctx.credentialLocatorStore.list().map((locator) => locator.credentialId),
  );
  for (const credentialId of credentialIds) {
    ctx.credentialLocatorStore.deleteByCredentialId(credentialId);
  }
  for (const connection of ctx.aiClientConnectionRepository.listByUserId()) {
    if (connection.status !== "active") continue;
    const found = ctx.aiClientConnectionRepository.findById(connection.id);
    if (found === null || found.entity.status !== "active") continue;
    ctx.aiClientConnectionRepository.save(
      AiClientConnection.revoke(found.entity, now),
      found.expectedVersion,
    );
  }
  ctx.accountStore.finishDeletion();
  ctx.updateOperation({ operationId: WITHDRAWAL_OPERATION_ID, phase: "done" });
}
