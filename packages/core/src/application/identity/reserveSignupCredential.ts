import type {
  MappingLocator,
  SealedCanonical,
} from "@repo/core/domain/identity/ports/credentialMappingRepository";
import {
  CredentialId,
  PasswordHash,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { SystemError, SystemErrorCode } from "../errors";
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
  /**
   * The mapping-key generation the bucket's key commitment names as
   * `active`, or `null` while the deployment is single-generation. The
   * generation guard below compares the row's generation against it.
   */
  activeGeneration: number | null;
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
 *
 * Two rules of `spec/rotation/index.md` sit on this write, the one path
 * that creates a mapping row from a request. **The generation guard**:
 * a reservation is taken in the active generation only, so a bucket whose
 * generation is not the commitment's `active` refuses it — `SystemError`,
 * the same answer as any infrastructure fault, and the user's retry
 * derives a fresh locator (`CONFIGURATION_ERROR`; during a deploy skew it
 * clears when the pair of variables agrees again). **The invalidation of
 * the retirement proof**: the row this transaction adds belongs to a
 * mapping generation and an encryption generation, and the checkpoint of
 * each is deleted with it, so a stale `previousCount = 0` cannot retire
 * a generation that is growing again after a roll-back.
 */
export function reserveCredentialProcedure(
  ctx: IdentityDirectoryUnitOfWorkContext,
  input: ReserveSignupCredentialInput,
): void {
  const { dto, locator } = input;
  if (
    input.activeGeneration !== null &&
    locator.generation !== input.activeGeneration
  ) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      "The reservation names a mapping-key generation that is not the active one",
    );
  }
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
  ctx.rotationCheckpointStore.delete(
    "remap",
    locator.bucketIndex,
    locator.generation,
  );
  ctx.rotationCheckpointStore.delete(
    "encryption",
    locator.bucketIndex,
    input.sealedCanonical.encryptionGeneration,
  );
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
