import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { ResumeCredentialChangePayload } from "@repo/core/application/identity/credentialChangeProcedures";
import type {
  CredentialCoordinateDto,
  PromoteVerifierDto,
} from "@repo/core/application/identity/gateway";
import { callDurableObject, userDataStub } from "../doStubs";
import type { StateWorkerEnv } from "../durableObjectBase";
import type { JobHandler } from "../jobRunner";
import type { UserDataDurableObject } from "../userDataDurableObject";

type ChangeRow = Readonly<{
  change_state: "pending" | "advanced" | null;
  operation_id: string | null;
}>;

export type ResumeCredentialChangeDeps = Readonly<{
  env: StateWorkerEnv;
  markAdvanced: (input: {
    coordinate: CredentialCoordinateDto;
    operationId: string;
  }) => Promise<boolean>;
  promote: (input: {
    coordinate: CredentialCoordinateDto;
    dto: PromoteVerifierDto;
  }) => Promise<boolean>;
}>;

/**
 * Re-drives the credential-change saga from the mapping row's own state
 * (`spec/recovery/index.md`). A row that is no longer changing, or that
 * another operation took over, ends the job with no write. `pending`
 * replays phases 2 and 3; `advanced` re-reads the version the User Data
 * side already holds and promotes. A phase that cannot advance throws,
 * and the runner's backoff brings the job back. Forward progress only —
 * the rollback stage of a `pending` row that exhausted its attempts is a
 * later slice (PH-09).
 */
export function createResumeCredentialChangeHandler(
  deps: ResumeCredentialChangeDeps,
): JobHandler {
  return async ({ storage, payload }) => {
    const { operationId, coordinate, userId, resetCompletion } =
      payload as ResumeCredentialChangePayload;
    const row = storage.sql
      .exec<ChangeRow>(
        "SELECT change_state, operation_id FROM credential_mappings WHERE credential_id = ?",
        coordinate.credentialId,
      )
      .toArray()[0];
    if (
      row === undefined ||
      row.change_state === null ||
      row.operation_id !== operationId
    ) {
      return { kind: "finished" };
    }
    const namespace = deps.env.USER_DATA;
    if (namespace === undefined) {
      throw new SystemError(
        SystemErrorCode.ConfigurationError,
        "resume-credential-change: USER_DATA binding is not configured",
      );
    }
    const stub = userDataStub(
      namespace,
      userId,
    ) as unknown as UserDataDurableObject;

    let credentialVersion: number;
    if (row.change_state === "pending") {
      const applied = await callDurableObject(() =>
        stub.applyCredentialChange({
          credentialId: coordinate.credentialId,
          resetCompletion,
        }),
      );
      credentialVersion = applied.credentialVersion;
      const advanced = await deps.markAdvanced({ coordinate, operationId });
      if (!advanced) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "resume-credential-change: the row left `pending` under another operation",
        );
      }
    } else {
      const locator = await callDurableObject(() =>
        stub.findCredentialLocator(coordinate.credentialId),
      );
      if (locator === null) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "resume-credential-change: the reverse index no longer names the credential",
        );
      }
      credentialVersion = locator.credentialVersion;
    }
    const promoted = await deps.promote({
      coordinate,
      dto: { operationId, credentialVersion },
    });
    if (!promoted) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "resume-credential-change: the verifier could not be promoted",
      );
    }
    return { kind: "finished" };
  };
}
