import type { CredentialChangeOrigin } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { ConflictError } from "../errors";
import type { UsecaseContainer } from "../types";
import type { CredentialCoordinateDto } from "./gateway";

export type CredentialChangeInput = Readonly<{
  coordinate: CredentialCoordinateDto;
  userId: string;
  credentialId: string;
  operationId: string;
  pendingVerifier: string;
  origin: CredentialChangeOrigin;
  changeAuthToken: string | null;
}>;

function conflict(): ConflictError {
  return new ConflictError(
    "OPTIMISTIC_LOCK_FAILURE",
    "The credential is being changed by another operation",
  );
}

/**
 * The credential-change saga, run to completion from the request side
 * (PH-06 △-5): phase 1 holds the new verifier in the bucket and enqueues
 * `resume-credential-change`; phase 2 advances the User Data side
 * (session epoch, credential version, and on a reset the reset version
 * with its automatic revocations); phase 3 records the advance and
 * promotes the verifier under the operation's own CAS. A phase lost to a
 * concurrent operation is a conflict; a phase lost to an outage is picked
 * up by the job, which replays the same idempotent calls.
 */
export async function runCredentialChange(
  container: UsecaseContainer,
  input: CredentialChangeInput,
): Promise<void> {
  const gateway = container.identityGateway;
  const began = await gateway.beginCredentialChange(input.coordinate, {
    operationId: input.operationId,
    userId: input.userId,
    pendingVerifier: input.pendingVerifier,
    origin: input.origin,
    changeAuthToken: input.changeAuthToken,
  });
  if (!began) throw conflict();

  const applied = await gateway.applyCredentialChange(input.userId, {
    credentialId: input.credentialId,
    resetCompletion: input.origin === "reset",
  });
  const advanced = await gateway.markCredentialChangeAdvanced(
    input.coordinate,
    input.operationId,
  );
  if (!advanced) throw conflict();
  const promoted = await gateway.promoteVerifier(input.coordinate, {
    operationId: input.operationId,
    credentialVersion: applied.credentialVersion,
  });
  if (!promoted) throw conflict();
}
