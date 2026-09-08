import { User } from "@repo/core/domain/identity/entity";
import { CredentialId } from "@repo/core/domain/identity/valueObject";
import { NotFoundError, SystemError, SystemErrorCode } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { BeginUnlinkDto, BeginUnlinkResult } from "./gateway";
import { SWEEP_ORPHAN_MAPPING_OPERATION_KEY } from "./jobKeys";
import { fromCredentialLocator } from "./rebuild";

export type UnlinkSsoCredentialInput = Readonly<{
  userId: string;
  credentialId: string;
}>;

/**
 * P-03 / P-13. The User Data side goes first and is final (the set, the
 * reverse index, the session epoch, the record of every generation's
 * locator, the `sweep-orphan-mapping` wake-up); the bucket rows are then
 * deleted "absent is success", and the sweep retries whatever the
 * request could not reach.
 */
export async function unlinkSsoCredential({
  container,
  input,
}: ServiceArgs<UnlinkSsoCredentialInput>): Promise<void> {
  const gateway = container.identityGateway;
  const operationId = container.idGenerator.next();
  const begun = await gateway.beginUnlink(input.userId, {
    operationId,
    credentialId: input.credentialId,
  });
  for (const locator of begun.locators) {
    await gateway.deleteMapping(
      {
        credentialId: locator.credentialId,
        kind: locator.kind,
        mapping: locator.mapping,
      },
      { userId: input.userId, callerToken: begun.callerToken },
    );
  }
  await gateway.finishUnlink(input.userId, { operationId });
}

/**
 * Inside the User Data DO, one transaction. The domain judges the kind
 * and the last-login-method rule (`User.removeCredential`).
 */
export function beginUnlinkProcedure(
  ctx: UserDataUnitOfWorkContext,
  dto: BeginUnlinkDto,
  now: Date,
  resumeAt: Date,
  callerToken: string | null,
): BeginUnlinkResult {
  const credentialId = CredentialId.create(dto.credentialId);
  const found = ctx.userSettingsRepository.find();
  if (found === null) {
    throw new NotFoundError("USER_NOT_FOUND", "The user was not found");
  }
  if (callerToken === null) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "The account has no caller binding",
    );
  }
  if (!found.entity.credentials.some((c) => c.credentialId === credentialId)) {
    throw new NotFoundError(
      "CREDENTIAL_NOT_FOUND",
      "The credential was not found",
    );
  }
  const user = User.removeCredential(found.entity, credentialId, now);
  ctx.userSettingsRepository.save(user, found.expectedVersion);
  const locators = ctx.credentialLocatorStore
    .listByCredentialId(credentialId)
    .map(fromCredentialLocator);
  ctx.recordOperation({
    operationId: dto.operationId,
    kind: "unlink",
    payload: { credentialId: dto.credentialId },
    phase: "deleting",
    targetLocators: locators,
  });
  ctx.credentialLocatorStore.deleteByCredentialId(credentialId);
  ctx.accountStore.advanceSessionEpoch();
  ctx.enqueueJob({
    operationKey: SWEEP_ORPHAN_MAPPING_OPERATION_KEY,
    kind: "sweep-orphan-mapping",
    payload: {},
    nextRunAt: resumeAt,
  });
  return { locators, callerToken };
}

export function finishUnlinkProcedure(
  ctx: UserDataUnitOfWorkContext,
  operationId: string,
): void {
  ctx.updateOperation({ operationId, phase: "done" });
}
