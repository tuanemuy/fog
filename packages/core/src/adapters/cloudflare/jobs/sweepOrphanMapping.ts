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
import {
  confirmDeletion,
  type DeletionTarget,
  noopSinceOf,
} from "@repo/core/application/identity/rotation/deletionConfirmation";
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
 *
 * Closing is subject to the no-op confirmation of
 * `spec/rotation/index.md`: stashed coordinates spanning two generations
 * whose round deleted nothing keep the record open, marked with
 * `noopSince` on the coordinates, until one more round after
 * `deleteNoopReissueDelayMs` — the round a copy that landed in between
 * cannot hide from.
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
    let nextRunAt: number | null = null;
    for (const row of rows) {
      const targets =
        row.target_locators === null
          ? []
          : (JSON.parse(row.target_locators) as CredentialLocatorDto[]);
      try {
        const outcomes: DeletionTarget[] = [];
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
          const { deleted } = await callDurableObject(() =>
            directory.deleteMapping({
              coordinate: {
                credentialId: target.credentialId,
                kind: target.kind,
                mapping: target.mapping,
              },
              dto: { userId, callerToken },
            }),
          );
          outcomes.push({ generation: locator.generation, deleted });
        }
        const verdict = confirmDeletion({
          targets: outcomes,
          noopSince: noopSinceOf(targets),
          now,
          reissueDelayMs: tuning.deleteNoopReissueDelayMs,
        });
        deps.provider().run((ctx) => {
          if (verdict.kind === "confirmed") {
            finishUnlinkProcedure(ctx, row.operation_id);
          } else {
            ctx.updateOperation({
              operationId: row.operation_id,
              phase: "deleting",
              targetLocators: targets.map((t) => ({
                ...t,
                noopSince: verdict.noopSince,
              })),
            });
          }
          return undefined;
        });
        if (verdict.kind === "reissue-after") {
          nextRunAt =
            nextRunAt === null ? verdict.at : Math.min(nextRunAt, verdict.at);
        }
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
        const retryAt = now + tuning.jobsBackoffBaseMs;
        nextRunAt = nextRunAt === null ? retryAt : Math.min(nextRunAt, retryAt);
        deps.logger.warn("sweep-orphan-mapping: record left open", {
          operationId: row.operation_id,
          cause: failureLabel(error, "unknown"),
        });
      }
    }
    if (nextRunAt === null) return { kind: "finished" };
    return { kind: "rearm", nextRunAt: new Date(nextRunAt) };
  };
}
