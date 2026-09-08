import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { CredentialRefDto } from "@repo/core/application/identity/gateway";
import type { MappingLocator } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { encodeMapping } from "../crypto/locatorDerivation";
import { callDurableObject, directoryStub, userDataStub } from "../doStubs";
import type { StateWorkerEnv } from "../durableObjectBase";
import type { IdentityDirectoryDurableObject } from "../identityDirectoryDurableObject";
import type { JobHandler } from "../jobRunner";
import type { UserDataDurableObject } from "../userDataDurableObject";

type CoordinatorRow = Readonly<{
  credential_id: string;
  kind: "email" | "sso";
  status: "reserved" | "active";
  user_id: string | null;
  candidate_user_id: string | null;
  saga_committed: number | null;
  caller_token: string;
  locators: string | null;
  password_verifier: string | null;
  credential_version: number;
  encrypted_canonical: string;
  encryption_generation: number;
  encryption_nonce: string;
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
  /** The coordinator's own canonical, opened in this DO: an SSO credential's label is its provider. */
  openCanonical: (row: {
    kind: "email" | "sso";
    credentialId: string;
    ciphertext: string;
    encryptionGeneration: number;
    nonce: string;
  }) => Promise<string | null>;
}>;

/** `provider U+0000 subject` → the provider, which is the credential's label. */
function ssoLabelOf(canonical: string): string {
  return canonical.split("\u0000")[0] ?? "";
}

/**
 * Re-drives registration phases 2–4 from the coordinator reservation row,
 * which is read by its PK (`kind`, `hmac`) — never by the mutable
 * `operation_id` — and must still carry the saga's `credential_id`. Every
 * phase is idempotent, so a saga the request path already completed ends
 * here with no further write. A row that is gone or belongs to another saga
 * is a lost-material failure; its cleanup stages arrive with the recovery
 * slice.
 *
 * The coordinator row's `locators` names every credential of the saga (one
 * for a password signup, two for an SSO signup): the account is initialised
 * with all of them, each is activated in its own bucket, and each gets its
 * reverse-index row. Only the coordinator can hold a verifier, so a member
 * is usable for login only when it is an SSO subject.
 *
 * A coordinator row that is already `active` with the saga mark is a saga
 * whose CAS phases (2 and 3) completed: they are skipped rather than
 * re-issued, because `credential_mappings.operation_id` is a mutable
 * column — a credential change that lands before this job wakes up
 * overwrites it (`spec/database/index.md`), and a CAS on the signup's
 * operation id would then miss on a row that needs nothing. The idempotent
 * phases (account initialisation, reverse-index rows) still run.
 */
export function createResumeSignupHandler(deps: ResumeSignupDeps): JobHandler {
  return async ({ storage, payload }) => {
    const { operationId, locator } = payload as ResumeSignupPayload;
    const row = storage.sql
      .exec<CoordinatorRow>(
        `SELECT credential_id, kind, status, user_id, candidate_user_id, saga_committed, caller_token, locators, password_verifier, credential_version,
                encrypted_canonical, encryption_generation, encryption_nonce
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
    const directoryNamespace = deps.env.IDENTITY_DIRECTORY;
    if (directoryNamespace === undefined) {
      throw new SystemError(
        SystemErrorCode.ConfigurationError,
        "resume-signup: IDENTITY_DIRECTORY binding is not configured",
      );
    }
    const locators = (
      row.locators === null ? [locator] : JSON.parse(row.locators)
    ) as readonly MappingLocator[];
    const isCoordinator = (l: MappingLocator) =>
      l.credentialId === locator.credentialId;
    const coordinatorCompleted =
      row.status === "active" &&
      row.saga_committed === 1 &&
      row.user_id === userId;
    const coordinatorLabel =
      row.kind === "sso"
        ? ssoLabelOf(
            (await deps.openCanonical({
              kind: row.kind,
              credentialId: row.credential_id,
              ciphertext: row.encrypted_canonical,
              encryptionGeneration: row.encryption_generation,
              nonce: row.encryption_nonce,
            })) ?? "",
          )
        : "";
    const credentialOf = (l: MappingLocator): CredentialRefDto => ({
      credentialId: l.credentialId,
      kind: l.kind,
      label: l.kind === "sso" && isCoordinator(l) ? coordinatorLabel : "",
      usableForLogin:
        l.kind === "sso" ||
        (isCoordinator(l) && row.password_verifier !== null),
    });
    const stub = userDataStub(
      namespace,
      userId,
    ) as unknown as UserDataDurableObject;

    await callDurableObject(() =>
      stub.initializeAccount({
        operationId,
        callerToken: row.caller_token,
        credentials: locators.map(credentialOf),
        locators,
      }),
    );
    if (!coordinatorCompleted) {
      const committed = await deps.commit({ locator, operationId });
      if (!committed) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "resume-signup: reservation lost before the saga mark",
        );
      }
    }
    for (const target of locators) {
      const activated = isCoordinator(target)
        ? coordinatorCompleted ||
          (await deps.activate({ locator: target, operationId, userId }))
        : await callDurableObject(() =>
            (
              directoryStub(
                directoryNamespace,
                target,
              ) as unknown as IdentityDirectoryDurableObject
            ).activateReservation({ locator: target, operationId, userId }),
          );
      if (!activated && !(isCoordinator(target) && row.status === "active")) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "resume-signup: reservation could not be activated",
        );
      }
    }
    for (const target of locators) {
      const credential = credentialOf(target);
      await callDurableObject(() =>
        stub.recordSignupLocator({
          operationId,
          locator: {
            credentialId: target.credentialId,
            kind: target.kind,
            mapping: encodeMapping(target),
            credentialVersion: isCoordinator(target)
              ? row.credential_version
              : 1,
            usableForLogin: credential.usableForLogin,
            label: credential.label,
          },
        }),
      );
    }
    return { kind: "finished" };
  };
}
