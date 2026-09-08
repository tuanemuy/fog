import {
  CredentialId,
  PasswordHash,
} from "@repo/core/domain/identity/valueObject";
import type {
  IdentityDirectoryUnitOfWorkContext,
  UserDataUnitOfWorkContext,
} from "../execution/unitOfWork";
import type {
  ApplyCredentialChangeDto,
  ApplyCredentialChangeResult,
  BeginCredentialChangeDto,
  CredentialCoordinateDto,
  PromoteVerifierDto,
} from "./gateway";
import { resumeCredentialChangeOperationKey } from "./jobKeys";
import { toCredentialCoordinate } from "./rebuild";

/** `resume-credential-change`'s payload: the coordinate and the user, nothing secret. */
export type ResumeCredentialChangePayload = Readonly<{
  operationId: string;
  coordinate: CredentialCoordinateDto;
  userId: string;
  resetCompletion: boolean;
}>;

/** Phase 1, inside the bucket: the pending verifier and the job that finishes the change if the request does not. */
export function beginCredentialChangeProcedure(
  ctx: IdentityDirectoryUnitOfWorkContext,
  coordinate: CredentialCoordinateDto,
  dto: BeginCredentialChangeDto,
  resumeAt: Date,
): boolean {
  const began = ctx.credentialMappingWriter.beginCredentialChange({
    coordinate: toCredentialCoordinate(coordinate),
    operationId: dto.operationId,
    pendingVerifier: PasswordHash.create(dto.pendingVerifier),
    origin: dto.origin,
    changeAuthToken: dto.changeAuthToken,
  });
  if (!began) return false;
  const payload: ResumeCredentialChangePayload = {
    operationId: dto.operationId,
    coordinate,
    userId: dto.userId,
    resetCompletion: dto.origin === "reset",
  };
  ctx.enqueueJob({
    operationKey: resumeCredentialChangeOperationKey(dto.operationId),
    kind: "resume-credential-change",
    payload,
    nextRunAt: resumeAt,
  });
  return true;
}

/**
 * Phase 2, inside the User Data DO: the session epoch and the credential
 * version advance; a reset completion also advances the reset version and
 * revokes the connections created under the previous one.
 */
export function applyCredentialChangeProcedure(
  ctx: UserDataUnitOfWorkContext,
  dto: ApplyCredentialChangeDto,
): ApplyCredentialChangeResult {
  ctx.accountStore.advanceSessionEpoch();
  const credentialVersion = ctx.credentialLocatorStore.advanceCredentialVersion(
    CredentialId.create(dto.credentialId),
  );
  if (dto.resetCompletion) {
    const advancedTo = ctx.accountStore.advanceResetVersion();
    ctx.aiClientConnectionRevoker.revokeCreatedAtResetVersion(advancedTo - 1);
  }
  return { credentialVersion };
}

export function markCredentialChangeAdvancedProcedure(
  ctx: IdentityDirectoryUnitOfWorkContext,
  coordinate: CredentialCoordinateDto,
  operationId: string,
): boolean {
  return ctx.credentialMappingWriter.markCredentialChangeAdvanced({
    coordinate: toCredentialCoordinate(coordinate),
    operationId,
  });
}

export function promoteVerifierProcedure(
  ctx: IdentityDirectoryUnitOfWorkContext,
  coordinate: CredentialCoordinateDto,
  dto: PromoteVerifierDto,
): boolean {
  return ctx.credentialMappingWriter.promoteVerifier({
    coordinate: toCredentialCoordinate(coordinate),
    operationId: dto.operationId,
    credentialVersion: dto.credentialVersion,
  });
}
