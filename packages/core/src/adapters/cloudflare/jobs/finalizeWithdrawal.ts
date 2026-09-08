import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  UnitOfWorkProvider,
  UserDataUnitOfWorkContext,
} from "@repo/core/application/execution/unitOfWork";
import type { CredentialLocatorDto } from "@repo/core/application/identity/gateway";
import type { MappingLocator } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { decodeMapping } from "../crypto/locatorDerivation";
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
 */
export function createFinalizeWithdrawalHandler(
  deps: FinalizeWithdrawalDeps,
): JobHandler {
  return async ({ storage }) => {
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

    // Every mapping this account still reaches, in every generation.
    const locators = sql
      .exec<{
        credential_id: string;
        kind: "email" | "sso";
        hmac: string;
        generation: number;
        bucket_index: number;
      }>(
        "SELECT credential_id, kind, hmac, generation, bucket_index FROM credential_locators",
      )
      .toArray();
    for (const row of locators) {
      const locator: MappingLocator = {
        credentialId: row.credential_id,
        kind: row.kind,
        hmac: row.hmac,
        generation: row.generation,
        bucketIndex: row.bucket_index,
      };
      await callDurableObject(() =>
        bucketOf(locator).deleteMapping({
          coordinate: {
            credentialId: row.credential_id,
            kind: row.kind,
            mapping: `g${row.generation}:b${row.bucket_index}:${row.hmac}`,
          },
          dto: { userId, callerToken },
        }),
      );
    }

    // Duty (1) and the tombstone, in one transaction; duty (3) is what is
    // absent from it (the records stay).
    const now = deps.now().getTime();
    deps.provider().run((ctx) => {
      void ctx;
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
      return undefined;
    });
    return { kind: "finished" };
  };
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
