import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  UnitOfWorkProvider,
  UserDataUnitOfWorkContext,
} from "@repo/core/application/execution/unitOfWork";
import type { CredentialLocatorDto } from "@repo/core/application/identity/gateway";
import { WITHDRAWAL_OPERATION_ID } from "@repo/core/application/identity/jobKeys";
import {
  confirmDeletion,
  type DeletionTarget,
  noopSinceOf,
} from "@repo/core/application/identity/rotation/deletionConfirmation";
import type { MappingLocator } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { decodeMapping, encodeMapping } from "../crypto/locatorDerivation";
import { callDurableObject, directoryStub } from "../doStubs";
import type { StateWorkerEnv } from "../durableObjectBase";
import type { IdentityDirectoryDurableObject } from "../identityDirectoryDurableObject";
import type { JobHandler } from "../jobRunner";
import { readCallerToken } from "../stores/accountStore";
import type { LinkTarget } from "./resumeLink";

type OpenOperationRow = Readonly<{
  operation_id: string;
  kind: "link" | "unlink";
  target_locators: string | null;
}>;

type WithdrawalRow = Readonly<{
  phase: string;
  target_locators: string | null;
}>;

/** A stashed withdrawal coordinate: the reverse-index row as a DTO, plus the no-op mark once a round ended in one. */
type WithdrawalTarget = Readonly<{
  credentialId: string;
  kind: "email" | "sso";
  mapping: string;
  noopSince?: number;
}>;

export type FinalizeWithdrawalDeps = Readonly<{
  env: StateWorkerEnv;
  userId: () => string;
  provider: () => UnitOfWorkProvider<UserDataUnitOfWorkContext>;
  now: () => Date;
}>;

/**
 * `finalize-withdrawal`: an account in `deleting` loses its reachability
 * and becomes a tombstone (`spec/recovery/index.md`, `spec/database`).
 * Forward only — there is nothing to roll a withdrawal back to, so a
 * failure that confirms terminates `poison` and the operator's last
 * resort is `purge-user-mappings`.
 *
 * The three duties toward the cleanups are kept in this order: every
 * open link / unlink record has its coordinates handed back and is
 * closed first, so that the caller binding is cleared only once no
 * record still needs it; the records themselves are never deleted.
 * What is removed is the account's reach — every mapping in every
 * generation, the reverse index, the AI connections, the spent codes —
 * and not its content, which no usecase of the spec asks to erase.
 *
 * The coordinates are stashed on an `operations` row of kind
 * `withdrawal` on the first run, so that the no-op confirmation of
 * `spec/rotation/index.md` has a record to mark: a round over two
 * generations that deleted nothing waits `deleteNoopReissueDelayMs` and
 * is issued once more before the tombstone is written.
 */
export function createFinalizeWithdrawalHandler(
  deps: FinalizeWithdrawalDeps,
): JobHandler {
  return async ({ storage, now: nowMs, tuning }) => {
    const sql = storage.sql;
    const account = sql
      .exec<{ status: string }>("SELECT status FROM account LIMIT 1")
      .toArray()[0];
    if (account === undefined || account.status !== "deleting") {
      return { kind: "finished" };
    }
    const callerToken = readCallerToken(sql);
    if (callerToken === null) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "finalize-withdrawal: the account has no caller binding",
      );
    }
    const directory = deps.env.IDENTITY_DIRECTORY;
    if (directory === undefined) {
      throw new SystemError(
        SystemErrorCode.ConfigurationError,
        "finalize-withdrawal: IDENTITY_DIRECTORY binding is not configured",
      );
    }
    const userId = deps.userId();
    const bucketOf = (locator: MappingLocator) =>
      directoryStub(
        directory,
        locator,
      ) as unknown as IdentityDirectoryDurableObject;

    // Duty (2): the open records first.
    const open = sql
      .exec<OpenOperationRow>(
        "SELECT operation_id, kind, target_locators FROM operations WHERE kind IN ('link','unlink') AND phase != 'done' ORDER BY created_at",
      )
      .toArray();
    for (const record of open) {
      for (const locator of targetsOf(record)) {
        await callDurableObject(() =>
          bucketOf(locator).cancelReservation({ locator, callerToken }),
        );
      }
      storage.transactionSync(() => {
        sql.exec(
          "UPDATE operations SET phase = 'done' WHERE operation_id = ? AND phase != 'done'",
          record.operation_id,
        );
      });
    }

    // The withdrawal's own record: every mapping this account still
    // reaches, in every generation, stashed once.
    const targets = withdrawalTargets(sql, deps.provider());
    const outcomes: DeletionTarget[] = [];
    for (const target of targets) {
      const decoded = decodeMapping(target.kind, target.mapping);
      if (decoded === null) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "finalize-withdrawal: the record carries an unreadable mapping",
        );
      }
      const { deleted } = await callDurableObject(() =>
        bucketOf({
          credentialId: target.credentialId,
          ...decoded,
        }).deleteMapping({
          coordinate: {
            credentialId: target.credentialId,
            kind: target.kind,
            mapping: target.mapping,
          },
          dto: { userId, callerToken },
        }),
      );
      outcomes.push({ generation: decoded.generation, deleted });
    }
    const verdict = confirmDeletion({
      targets: outcomes,
      noopSince: noopSinceOf(targets),
      now: nowMs,
      reissueDelayMs: tuning.deleteNoopReissueDelayMs,
    });
    if (verdict.kind === "reissue-after") {
      deps.provider().run((ctx) => {
        ctx.updateOperation({
          operationId: WITHDRAWAL_OPERATION_ID,
          phase: "deleting",
          targetLocators: targets.map((t) => ({
            ...t,
            noopSince: verdict.noopSince,
          })),
        });
        return undefined;
      });
      return { kind: "rearm", nextRunAt: new Date(verdict.at) };
    }

    // Duty (1) and the tombstone, in one transaction; duty (3) is what is
    // absent from it (the records stay, the withdrawal's included).
    const now = deps.now().getTime();
    deps.provider().run((ctx) => {
      sql.exec("DELETE FROM credential_locators");
      sql.exec(
        `UPDATE ai_client_connections SET status = 'revoked', revoked_at = ?, version = version + 1, updated_at = ?
         WHERE status = 'active'`,
        now,
        now,
      );
      sql.exec("DELETE FROM oauth_consumed_codes");
      sql.exec(
        `UPDATE account SET status = 'deleted', caller_token = NULL, deleted_at = ?, session_epoch = session_epoch + 1, updated_at = ?
         WHERE status = 'deleting'`,
        now,
        now,
      );
      ctx.updateOperation({
        operationId: WITHDRAWAL_OPERATION_ID,
        phase: "done",
      });
      return undefined;
    });
    return { kind: "finished" };
  };
}

/**
 * The withdrawal's stashed coordinates, written on the first run from the
 * reverse index and read back afterwards — so a later run sees the same
 * set the first one issued, with whatever mark it left.
 */
function withdrawalTargets(
  sql: SqlStorage,
  provider: UnitOfWorkProvider<UserDataUnitOfWorkContext>,
): WithdrawalTarget[] {
  const record = sql
    .exec<WithdrawalRow>(
      "SELECT phase, target_locators FROM operations WHERE operation_id = ?",
      WITHDRAWAL_OPERATION_ID,
    )
    .toArray()[0];
  if (record !== undefined) {
    return record.target_locators === null
      ? []
      : (JSON.parse(record.target_locators) as WithdrawalTarget[]);
  }
  const snapshot: WithdrawalTarget[] = sql
    .exec<{
      credential_id: string;
      kind: "email" | "sso";
      hmac: string;
      generation: number;
      bucket_index: number;
    }>(
      "SELECT credential_id, kind, hmac, generation, bucket_index FROM credential_locators ORDER BY credential_id, generation",
    )
    .toArray()
    .map((row) => ({
      credentialId: row.credential_id,
      kind: row.kind,
      mapping: encodeMapping({
        kind: row.kind,
        hmac: row.hmac,
        generation: row.generation,
        bucketIndex: row.bucket_index,
      }),
    }));
  provider.run((ctx) => {
    ctx.recordOperation({
      operationId: WITHDRAWAL_OPERATION_ID,
      kind: "withdrawal",
      payload: {},
      phase: "deleting",
      targetLocators: snapshot,
    });
    return undefined;
  });
  return snapshot;
}

/** A link record stores mapping locators with labels; an unlink record stores coordinate DTOs. */
function targetsOf(record: OpenOperationRow): MappingLocator[] {
  if (record.target_locators === null) return [];
  const parsed = JSON.parse(record.target_locators) as unknown[];
  const out: MappingLocator[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    if ("hmac" in item) {
      const t = item as LinkTarget;
      out.push({
        credentialId: t.credentialId,
        kind: t.kind,
        hmac: t.hmac,
        generation: t.generation,
        bucketIndex: t.bucketIndex,
      });
      continue;
    }
    const dto = item as CredentialLocatorDto;
    const decoded = decodeMapping(dto.kind, dto.mapping);
    if (decoded === null) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "finalize-withdrawal: a record carries an unreadable mapping",
      );
    }
    out.push({ credentialId: dto.credentialId, ...decoded });
  }
  return out;
}
