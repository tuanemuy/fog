import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import { callDurableObject, directoryStub } from "../../doStubs";
import type { StateWorkerEnv } from "../../durableObjectBase";
import type { IdentityDirectoryDurableObject } from "../../identityDirectoryDurableObject";
import type { JobHandler } from "../../jobRunner";
import { readCallerToken } from "../../stores/accountStore";
import { writeUpdatedOperation } from "../../stores/operationsStore";
import type { LinkTarget } from "../resumeLink";

type LinkOperationRow = Readonly<{
  phase: string;
  target_locators: string | null;
}>;

export type LinkCleanupDeps = Readonly<{ env: StateWorkerEnv }>;

/**
 * L1〜L3 of `spec/recovery/index.md`: the roll-back of an SSO link that
 * cannot finish. L1 reads the record by `operation_id`; no record is lost
 * material (`poison` at once), a `done` record was taken over by the
 * withdrawal side (nothing to do). L2 hands back every reserved
 * coordinate through `cancel-reservation` — the row may be `reserved` or
 * an orphan `active`, and the same entry covers both. L3 closes the
 * record in the transaction that marks the job `done`, leaving
 * `target_locators` in place.
 */
export function createLinkCleanupHandler(deps: LinkCleanupDeps): JobHandler {
  return async ({ storage, payload }) => {
    const { operationId } = payload as { operationId: string };
    const sql = storage.sql;
    const row = sql
      .exec<LinkOperationRow>(
        "SELECT phase, target_locators FROM operations WHERE operation_id = ? AND kind = 'link'",
        operationId,
      )
      .toArray()[0];
    if (row === undefined) return { kind: "poison", reason: "material-lost" };
    if (row.phase === "done") return { kind: "finished" };
    const callerToken = readCallerToken(sql);
    // The binding is cleared only by a completed withdrawal, which has
    // taken every open record with it (spec: the withdrawal's three
    // duties); nothing is left for this stage.
    if (callerToken === null) return { kind: "finished" };
    const targets =
      row.target_locators === null
        ? []
        : (JSON.parse(row.target_locators) as LinkTarget[]);
    const directory = deps.env.IDENTITY_DIRECTORY;
    if (directory === undefined) {
      throw new SystemError(
        SystemErrorCode.ConfigurationError,
        "link cleanup: IDENTITY_DIRECTORY binding is not configured",
      );
    }
    for (const target of targets) {
      await callDurableObject(() =>
        (
          directoryStub(
            directory,
            target,
          ) as unknown as IdentityDirectoryDurableObject
        ).cancelReservation({ locator: target, callerToken }),
      );
    }
    return {
      kind: "finished",
      commit: (tx) => {
        writeUpdatedOperation(tx, { operationId, phase: "done" });
        return undefined;
      },
    };
  };
}
