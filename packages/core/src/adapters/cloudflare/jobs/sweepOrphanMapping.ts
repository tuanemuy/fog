import {
  isSystemError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import type {
  UnitOfWorkProvider,
  UserDataUnitOfWorkContext,
} from "@repo/core/application/execution/unitOfWork";
import type { CredentialLocatorDto } from "@repo/core/application/identity/gateway";
import { finishUnlinkProcedure } from "@repo/core/application/identity/unlinkSsoCredential";
import type { Logger } from "@repo/core/application/ports/logger";
import { decodeMapping } from "../crypto/locatorDerivation";
import { callDurableObject, directoryStub } from "../doStubs";
import type { StateWorkerEnv } from "../durableObjectBase";
import type { IdentityDirectoryDurableObject } from "../identityDirectoryDurableObject";
import type { JobHandler } from "../jobRunner";
import { failureLabel } from "../rowRunner";
import { readCallerToken } from "../stores/accountStore";

type UnlinkOperationRow = Readonly<{
  operation_id: string;
  target_locators: string | null;
}>;

export type SweepOrphanMappingDeps = Readonly<{
  env: StateWorkerEnv;
  userId: () => string;
  provider: () => UnitOfWorkProvider<UserDataUnitOfWorkContext>;
  logger: Logger;
}>;

/**
 * `sweep-orphan-mapping`: every unlink whose record is not `done` has its
 * remaining bucket rows deleted ("absent is success"), then the record
 * closes. A bucket that cannot be reached leaves its record open, and the
 * job re-arms with the backoff; it ends `finished` only when no record
 * remains (a later unlink revives it, `revivesFromDone`).
 */
export function createSweepOrphanMappingHandler(
  deps: SweepOrphanMappingDeps,
): JobHandler {
  return async ({ storage, now, tuning }) => {
    const rows = storage.sql
      .exec<UnlinkOperationRow>(
        "SELECT operation_id, target_locators FROM operations WHERE kind = 'unlink' AND phase != 'done' ORDER BY created_at",
      )
      .toArray();
    if (rows.length === 0) return { kind: "finished" };
    const namespace = deps.env.IDENTITY_DIRECTORY;
    if (namespace === undefined) {
      throw new SystemError(
        SystemErrorCode.ConfigurationError,
        "sweep-orphan-mapping: IDENTITY_DIRECTORY binding is not configured",
      );
    }
    const callerToken = readCallerToken(storage.sql);
    if (callerToken === null) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "sweep-orphan-mapping: the account has no caller binding",
      );
    }
    const userId = deps.userId();
    let remaining = 0;
    for (const row of rows) {
      const targets =
        row.target_locators === null
          ? []
          : (JSON.parse(row.target_locators) as CredentialLocatorDto[]);
      try {
        for (const target of targets) {
          const locator = decodeMapping(target.kind, target.mapping);
          if (locator === null) {
            throw new SystemError(
              SystemErrorCode.DataIntegrityError,
              "sweep-orphan-mapping: the record carries an unreadable mapping",
            );
          }
          const directory = directoryStub(
            namespace,
            locator,
          ) as unknown as IdentityDirectoryDurableObject;
          await callDurableObject(() =>
            directory.deleteMapping({
              coordinate: {
                credentialId: target.credentialId,
                kind: target.kind,
                mapping: target.mapping,
              },
              dto: { userId, callerToken },
            }),
          );
        }
        deps.provider().run((ctx) => {
          finishUnlinkProcedure(ctx, row.operation_id);
          return undefined;
        });
      } catch (error) {
        // A record whose material cannot be read never completes by
        // retrying: that is the runner's poison path, not a re-arm.
        if (
          isSystemError(error) &&
          error.code === SystemErrorCode.DataIntegrityError
        ) {
          throw error;
        }
        // Per-record tolerance, like the runner's per-job one: one bucket
        // that cannot be reached must not hold the other records back.
        remaining += 1;
        deps.logger.warn("sweep-orphan-mapping: record left open", {
          operationId: row.operation_id,
          cause: failureLabel(error, "unknown"),
        });
      }
    }
    if (remaining === 0) return { kind: "finished" };
    return {
      kind: "rearm",
      nextRunAt: new Date(now + tuning.jobsBackoffBaseMs),
    };
  };
}
