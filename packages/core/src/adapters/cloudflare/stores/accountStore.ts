import type {
  AccountState,
  AccountStore,
} from "@repo/core/domain/identity/ports/accountStore";
import { updateMatchedRow } from "../rowRunner";

type AccountRow = Readonly<{
  status: "active" | "deleting" | "deleted";
  session_epoch: number;
  reset_version: number;
}>;

/**
 * `account` — one row. The counters advance in statements that neither read
 * nor move `version`; `caller_token` is written once by initialisation and is
 * never read back through this port.
 */
export function createAccountStore(
  sql: SqlStorage,
  now: () => number,
): AccountStore {
  return {
    find(): AccountState | null {
      const row = sql
        .exec<AccountRow>(
          "SELECT status, session_epoch, reset_version FROM account LIMIT 1",
        )
        .toArray()[0];
      if (!row) return null;
      return {
        status: row.status,
        sessionEpoch: row.session_epoch,
        resetVersion: row.reset_version,
      };
    },

    advanceSessionEpoch() {
      sql.exec(
        "UPDATE account SET session_epoch = session_epoch + 1, updated_at = ?",
        now(),
      );
    },

    advanceResetVersion(): number {
      const row = sql
        .exec<{ reset_version: number }>(
          "UPDATE account SET reset_version = reset_version + 1, updated_at = ? RETURNING reset_version",
          now(),
        )
        .toArray()[0];
      if (!row) throw new Error("account row is missing");
      return row.reset_version;
    },

    initializeCallerBinding(callerToken) {
      const at = now();
      const existing = sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM account")
        .one().n;
      if (existing === 0) {
        sql.exec(
          `INSERT INTO account (status, session_epoch, deleted_at, caller_token, reset_version, version, created_at, updated_at)
           VALUES ('active', 0, NULL, ?, 0, 0, ?, ?)`,
          callerToken,
          at,
          at,
        );
        return;
      }
      sql.exec(
        "UPDATE account SET caller_token = ?, updated_at = ?",
        callerToken,
        at,
      );
    },

    beginDeletion() {
      updateMatchedRow(
        sql,
        `UPDATE account SET status = 'deleting', session_epoch = session_epoch + 1, updated_at = ?
         WHERE status = 'active'`,
        now(),
      );
    },
  };
}

/** The binding value, for the RPC guards that compare against it. */
export function readCallerToken(sql: SqlStorage): string | null {
  return (
    sql
      .exec<{ caller_token: string | null }>(
        "SELECT caller_token FROM account LIMIT 1",
      )
      .toArray()[0]?.caller_token ?? null
  );
}
