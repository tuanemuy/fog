import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  AccountState,
  AccountStatus,
  AccountStore,
} from "@repo/core/domain/identity/ports/accountStore";
import { matchOpaque } from "../identityDirectory/opaqueBinding";
import { one, run, type Sql } from "../sql/exec";

type AccountRow = {
  status: string;
  session_epoch: number;
  reset_version: number;
};

const STATUSES: ReadonlySet<string> = new Set([
  "active",
  "deleting",
  "deleted",
]);

/**
 * `account`, the single-row table that owns revocation.
 *
 * Neither advance carries an OCC predicate and neither bumps `version`: both
 * move a monotonic counter, and conditioning them on `version` would make an
 * unrelated settings write able to lose a revocation.
 */
export function createAccountStore(sql: Sql, now: () => number): AccountStore {
  return {
    find(): AccountState | null {
      const row = one<AccountRow>(
        sql,
        "SELECT status, session_epoch, reset_version FROM account",
      );
      if (row === null) return null;
      if (!STATUSES.has(row.status)) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "Stored account status is outside its domain",
        );
      }
      return {
        status: row.status as AccountStatus,
        sessionEpoch: row.session_epoch,
        resetVersion: row.reset_version,
      };
    },

    advanceSessionEpoch(): void {
      const row = one<{ session_epoch: number }>(
        sql,
        `UPDATE account
            SET session_epoch = session_epoch + 1, updated_at = ?
        RETURNING session_epoch`,
        now(),
      );
      if (row === null) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "No account row to advance the session epoch on",
        );
      }
    },

    advanceResetVersion(): number {
      // Returns the value *after* the advance rather than re-reading it: a
      // separate read could observe a different value than the one written,
      // and the revocation scope is derived from exactly this number.
      const row = one<{ reset_version: number }>(
        sql,
        `UPDATE account
            SET reset_version = reset_version + 1, updated_at = ?
        RETURNING reset_version`,
        now(),
      );
      if (row === null) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "No account row to advance the reset version on",
        );
      }
      return row.reset_version;
    },

    initialize(callerToken: string, now: Date): void {
      const timestamp = now.getTime();
      run(
        sql,
        `INSERT INTO account (
           status, session_epoch, deleted_at, caller_token, reset_version,
           version, created_at, updated_at
         ) VALUES ('active', 0, NULL, ?, 0, 0, ?, ?)`,
        callerToken,
        timestamp,
        timestamp,
      );
    },

    matchCallerToken(token: string | null | undefined): boolean {
      const row = one<{ caller_token: string | null }>(
        sql,
        "SELECT caller_token FROM account",
      );
      return matchOpaque(row?.caller_token ?? null, token);
    },
  };
}
