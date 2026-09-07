import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { MappingLocator } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { encodeMapping } from "../crypto/locatorDerivation";
import { callDurableObject, userDataStub } from "../doStubs";
import type { StateWorkerEnv } from "../durableObjectBase";
import type { JobHandler } from "../jobRunner";
import type { UserDataDurableObject } from "../userDataDurableObject";

type CoordinatorRow = Readonly<{
  credential_id: string;
  kind: "email" | "sso";
  status: "reserved" | "active";
  user_id: string | null;
  candidate_user_id: string | null;
  caller_token: string;
  locators: string | null;
  password_verifier: string | null;
  credential_version: number;
}>;

export type ResumeSignupPayload = Readonly<{
  operationId: string;
  locator: MappingLocator;
}>;

export type ResumeSignupDeps = Readonly<{
  env: StateWorkerEnv;
  commit: (input: {
    locator: MappingLocator;
    operationId: string;
  }) => Promise<boolean>;
  activate: (input: {
    locator: MappingLocator;
    operationId: string;
    userId: string;
  }) => Promise<boolean>;
}>;

/**
 * Re-drives registration phases 2–4 from the coordinator reservation row,
 * which is read by its PK (`kind`, `hmac`) — never by the mutable
 * `operation_id` — and must still carry the saga's `credential_id`. Every
 * phase is idempotent, so a saga the request path already completed ends
 * here with no further write. A row that is gone or belongs to another saga
 * is a lost-material failure; its cleanup stages arrive with the recovery
 * slice.
 */
export function createResumeSignupHandler(deps: ResumeSignupDeps): JobHandler {
  return async ({ storage, payload }) => {
    const { operationId, locator } = payload as ResumeSignupPayload;
    const row = storage.sql
      .exec<CoordinatorRow>(
        `SELECT credential_id, kind, status, user_id, candidate_user_id, caller_token, locators, password_verifier, credential_version
         FROM credential_mappings WHERE kind = ? AND hmac = ?`,
        locator.kind,
        locator.hmac,
      )
      .toArray()[0];
    if (!row || row.credential_id !== locator.credentialId) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "resume-signup: coordinator reservation is missing",
      );
    }
    const userId = row.user_id ?? row.candidate_user_id;
    if (userId === null) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "resume-signup: reservation names no account",
      );
    }
    const namespace = deps.env.USER_DATA;
    if (namespace === undefined) {
      throw new SystemError(
        SystemErrorCode.ConfigurationError,
        "resume-signup: USER_DATA binding is not configured",
      );
    }
    const locators = (
      row.locators === null ? [locator] : JSON.parse(row.locators)
    ) as readonly MappingLocator[];
    const usableForLogin = row.kind === "sso" || row.password_verifier !== null;
    const stub = userDataStub(
      namespace,
      userId,
    ) as unknown as UserDataDurableObject;

    await callDurableObject(() =>
      stub.initializeAccount({
        operationId,
        callerToken: row.caller_token,
        credential: {
          credentialId: row.credential_id,
          kind: row.kind,
          label: "",
          usableForLogin,
        },
        locators,
      }),
    );
    const committed = await deps.commit({ locator, operationId });
    if (!committed) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "resume-signup: reservation lost before the saga mark",
      );
    }
    const activated = await deps.activate({ locator, operationId, userId });
    if (!activated && row.status !== "active") {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "resume-signup: reservation could not be activated",
      );
    }
    await callDurableObject(() =>
      stub.recordSignupLocator({
        operationId,
        locator: {
          credentialId: row.credential_id,
          kind: row.kind,
          mapping: encodeMapping(locator),
          credentialVersion: row.credential_version,
          usableForLogin,
          label: "",
        },
      }),
    );
    return { kind: "finished" };
  };
}
