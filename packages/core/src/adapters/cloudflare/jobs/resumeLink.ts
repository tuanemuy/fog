import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  UnitOfWorkProvider,
  UserDataUnitOfWorkContext,
} from "@repo/core/application/execution/unitOfWork";
import {
  completeLinkProcedure,
  finishLinkProcedure,
} from "@repo/core/application/identity/linkSsoCredential";
import { INITIAL_CREDENTIAL_VERSION } from "@repo/core/application/identity/signupSaga";
import type { MappingLocator } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { encodeMapping } from "../crypto/locatorDerivation";
import { callDurableObject, directoryStub } from "../doStubs";
import type { StateWorkerEnv } from "../durableObjectBase";
import type { IdentityDirectoryDurableObject } from "../identityDirectoryDurableObject";
import type { JobHandler } from "../jobRunner";

type LinkOperationRow = Readonly<{
  phase: string;
  target_locators: string | null;
}>;

/** What `beginLinkProcedure` stored: the mapping locator plus the credential's label. */
export type LinkTarget = MappingLocator & Readonly<{ label: string }>;

export type ResumeLinkDeps = Readonly<{
  env: StateWorkerEnv;
  userId: () => string;
  provider: () => UnitOfWorkProvider<UserDataUnitOfWorkContext>;
  now: () => Date;
}>;

/**
 * `resume-link`: finishes a link the request did not. The record decides:
 * `done` is nothing to do. Otherwise the reservation is activated for this
 * account (idempotent: an already-active row answers `false`), and the
 * row is read back — ours means the credential joins the set and the
 * reverse index; anything else (lost, or never reserved) closes the
 * record with nothing to roll back. The rollback stages of a link that
 * cannot be finished are a later slice (PH-09).
 */
export function createResumeLinkHandler(deps: ResumeLinkDeps): JobHandler {
  return async ({ storage, payload }) => {
    const { operationId } = payload as { operationId: string };
    const row = storage.sql
      .exec<LinkOperationRow>(
        "SELECT phase, target_locators FROM operations WHERE operation_id = ? AND kind = 'link'",
        operationId,
      )
      .toArray()[0];
    if (row === undefined || row.phase === "done") return { kind: "finished" };
    const target = (
      row.target_locators === null
        ? []
        : (JSON.parse(row.target_locators) as LinkTarget[])
    )[0];
    if (target === undefined) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "resume-link: the record names no locator",
      );
    }
    const namespace = deps.env.IDENTITY_DIRECTORY;
    if (namespace === undefined) {
      throw new SystemError(
        SystemErrorCode.ConfigurationError,
        "resume-link: IDENTITY_DIRECTORY binding is not configured",
      );
    }
    const userId = deps.userId();
    const directory = directoryStub(
      namespace,
      target,
    ) as unknown as IdentityDirectoryDurableObject;
    await callDurableObject(() =>
      directory.activateReservation({ locator: target, operationId, userId }),
    );
    const record = await callDurableObject(() =>
      directory.resolveLoginCredential(target),
    );
    const ours =
      record !== null &&
      record.userId === userId &&
      record.coordinate.credentialId === target.credentialId;

    const provider = deps.provider();
    const now = deps.now();
    provider.run((ctx) => {
      if (ours) {
        completeLinkProcedure(
          ctx,
          {
            operationId,
            locator: {
              credentialId: target.credentialId,
              kind: target.kind,
              mapping: encodeMapping(target),
              credentialVersion: INITIAL_CREDENTIAL_VERSION,
              usableForLogin: true,
              label: target.label,
            },
          },
          now,
        );
      } else {
        finishLinkProcedure(ctx, operationId);
      }
      return undefined;
    });
    return { kind: "finished" };
  };
}
