import type {
  MappingLocator,
  SealedCanonical,
} from "@repo/core/domain/identity/ports/credentialMappingRepository";
import {
  CredentialId,
  PasswordHash,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import type { IdentityDirectoryUnitOfWorkContext } from "../execution/unitOfWork";
import type { ReserveCredentialDto } from "./gateway";

export const SWEEP_RESERVATIONS_OPERATION_KEY = "sweep-reservations";

export function resumeSignupOperationKey(operationId: string): string {
  return `resume-signup:${operationId}`;
}

export type ReserveSignupCredentialInput = Readonly<{
  locator: MappingLocator;
  mapping: string;
  sealedCanonical: SealedCanonical;
  dto: ReserveCredentialDto;
  /** When the coordinator bucket first re-drives the saga. */
  resumeAt: Date;
}>;

/**
 * Registration saga phase 1 inside the Identity Directory bucket: the
 * reservation row, the `sweep-reservations` job for its expiry, and — for the
 * coordinator bucket only — the `resume-signup` job that re-drives the saga.
 * All three land in the one transaction that writes the row.
 */
export function reserveSignupCredentialProcedure(
  ctx: IdentityDirectoryUnitOfWorkContext,
  input: ReserveSignupCredentialInput,
): void {
  const { dto, locator } = input;
  ctx.credentialMappingWriter.reserveCredential({
    coordinate: {
      credentialId: CredentialId.create(locator.credentialId),
      kind: locator.kind,
      mapping: input.mapping,
    },
    operationId: dto.operationId,
    candidateUserId: UserId.create(dto.candidateUserId),
    callerToken: dto.callerToken,
    sealedCanonical: input.sealedCanonical,
    passwordVerifier:
      dto.passwordVerifier === null
        ? null
        : PasswordHash.create(dto.passwordVerifier),
    reservedUntil: dto.reservedUntil,
    coordinator: dto.coordinator,
  });
  ctx.enqueueJob({
    operationKey: SWEEP_RESERVATIONS_OPERATION_KEY,
    kind: "sweep-reservations",
    payload: {},
    nextRunAt: dto.reservedUntil,
  });
  if (dto.coordinator.role === "coordinator") {
    ctx.enqueueJob({
      operationKey: resumeSignupOperationKey(dto.operationId),
      kind: "resume-signup",
      payload: { operationId: dto.operationId, locator },
      nextRunAt: input.resumeAt,
    });
  }
}
