import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { AbandonAccountResult } from "@repo/core/application/identity/abandonAccount";
import type { MappingLocator } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { callDurableObject, directoryStub, userDataStub } from "../../doStubs";
import type { StateWorkerEnv } from "../../durableObjectBase";
import type { IdentityDirectoryDurableObject } from "../../identityDirectoryDurableObject";
import type { JobHandler } from "../../jobRunner";
import type { UserDataDurableObject } from "../../userDataDurableObject";
import type { ResumeSignupPayload } from "../resumeSignup";

type CoordinatorRow = Readonly<{
  credential_id: string;
  user_id: string | null;
  candidate_user_id: string | null;
  caller_token: string;
  locators: string | null;
}>;

export type SignupCleanupDeps = Readonly<{
  env: StateWorkerEnv;
  /** This bucket's own coordinates: a target here is cancelled locally, not over RPC to itself. */
  bucket: () => { generation: number; bucketIndex: number };
}>;

/**
 * S1〜S4 of `spec/recovery/index.md`: the abandonment of a registration
 * that cannot finish.
 *
 * S1 reads the coordinator reservation by its PK (the locator in the
 * payload; never `operation_id`, which a later change may overwrite) and
 * takes the materials from it; a row that is gone or belongs to another
 * saga is lost material and the row is `poison`ed at once. S2 asks the
 * candidate account to abandon itself — `already-completed` means the
 * saga did finish and the cleanup ends with nothing touched. S3 hands
 * back every other reservation. S4 hands back the coordinator's own row
 * and its reset tokens in the transaction that marks the job `done`.
 * S2 before S3 is not negotiable: releasing the canonicals first would
 * leave an account no listing can reach.
 */
export function createSignupCleanupHandler(
  deps: SignupCleanupDeps,
): JobHandler {
  return async ({ storage, payload }) => {
    const { operationId, locator } = payload as ResumeSignupPayload;
    const sql = storage.sql;
    const row = sql
      .exec<CoordinatorRow>(
        `SELECT credential_id, user_id, candidate_user_id, caller_token, locators
         FROM credential_mappings WHERE kind = ? AND hmac = ?`,
        locator.kind,
        locator.hmac,
      )
      .toArray()[0];
    if (row === undefined || row.credential_id !== locator.credentialId) {
      return { kind: "poison", reason: "material-lost" };
    }
    const candidateUserId = row.user_id ?? row.candidate_user_id;
    if (candidateUserId === null) {
      return { kind: "poison", reason: "material-lost" };
    }
    const locators = (
      row.locators === null ? [locator] : JSON.parse(row.locators)
    ) as readonly MappingLocator[];
    const callerToken = row.caller_token;
    const userData = deps.env.USER_DATA;
    const directory = deps.env.IDENTITY_DIRECTORY;
    if (userData === undefined || directory === undefined) {
      throw new SystemError(
        SystemErrorCode.ConfigurationError,
        "signup cleanup: the Durable Object bindings are not configured",
      );
    }

    // S2
    const outcome: AbandonAccountResult = await callDurableObject(() =>
      (
        userDataStub(
          userData,
          candidateUserId,
        ) as unknown as UserDataDurableObject
      ).abandonAccount({ operationId, callerToken }),
    );
    if (outcome === "already-completed") return { kind: "finished" };

    // S3: every reservation but the coordinator's, by credential id.
    const self = deps.bucket();
    for (const target of locators) {
      if (target.credentialId === locator.credentialId) continue;
      if (
        target.generation === self.generation &&
        target.bucketIndex === self.bucketIndex
      ) {
        storage.transactionSync(() => cancelLocally(sql, target, callerToken));
        continue;
      }
      await callDurableObject(() =>
        (
          directoryStub(
            directory,
            target,
          ) as unknown as IdentityDirectoryDurableObject
        ).cancelReservation({ locator: target, callerToken }),
      );
    }

    // S4: the coordinator's row and its tokens go with the row's `done`.
    return {
      kind: "finished",
      commit: (tx) => {
        cancelLocally(tx, locator, callerToken);
        return undefined;
      },
    };
  };
}

/** The `cancel-reservation` write, in this bucket: the same CAS predicate, the same token sweep. */
function cancelLocally(
  sql: SqlStorage,
  locator: MappingLocator,
  callerToken: string,
): void {
  sql.exec(
    `DELETE FROM credential_mappings
     WHERE kind = ? AND hmac = ? AND credential_id = ? AND caller_token = ?`,
    locator.kind,
    locator.hmac,
    locator.credentialId,
    callerToken,
  );
  sql.exec(
    "DELETE FROM password_reset_tokens WHERE credential_id = ?",
    locator.credentialId,
  );
}
