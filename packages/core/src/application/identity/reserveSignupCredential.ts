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
 * Reservation inside the Identity Directory bucket, for both the
 * registration saga (phase 1) and a link: the reservation row, the
 * `sweep-reservations` job for its expiry, and — for the coordinator of a
 * **signup** only — the `resume-signup` job that re-drives the saga. A
 * link's reservation enqueues no re-drive here: its saga is owned by the
 * User Data record and `resume-link` (`spec/async/index.md` names the
 * signup reservation as `resume-signup`'s only entry point). All writes
 * land in the one transaction that writes the row.
 */
export function reserveCredentialProcedure(
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
  if (dto.saga === "signup" && dto.coordinator.role === "coordinator") {
    ctx.enqueueJob({
      operationKey: resumeSignupOperationKey(dto.operationId),
      kind: "resume-signup",
      payload: { operationId: dto.operationId, locator },
      nextRunAt: input.resumeAt,
    });
  }
}
