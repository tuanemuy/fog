import type {
  CurrentAccount,
  RpcResult,
} from "@repo/core/application/identity/contracts";
import type { DurableSqlStorage } from "../sql";

export class AccountHomeStore {
  constructor(private readonly storage: DurableSqlStorage) {}

  beginSignup(input: {
    operationId: string;
    userId: string;
    email: string;
    opaqueKey: string;
    generation: string;
    now: number;
  }): RpcResult<{ state: string }> {
    return this.storage.transactionSync(() => {
      const operation = this.storage.sql
        .exec<{ state: string }>(
          "SELECT state FROM identity_operations WHERE operation_id = ?",
          input.operationId,
        )
        .toArray()[0];
      if (operation) return { ok: true, value: { state: operation.state } };
      const existing = this.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM account WHERE singleton = 1",
        )
        .toArray()[0];
      if (existing && existing.status !== "pending") {
        return {
          ok: false,
          error: {
            kind: "conflict",
            code: "ACCOUNT_ALREADY_INITIALIZED",
            message: "Account is already initialized",
          },
        };
      }
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO account(
           singleton, user_id, status, primary_email, auth_method,
           created_at, updated_at
         ) VALUES (1, ?, 'pending', ?, 'password', ?, ?)`,
        input.userId,
        input.email,
        input.now,
        input.now,
      );
      this.storage.sql.exec(
        `INSERT INTO credential_locators(
           opaque_key, generation, kind, state, created_at, updated_at
         ) VALUES (?, ?, 'password', 'reserved', ?, ?)`,
        input.opaqueKey,
        input.generation,
        input.now,
        input.now,
      );
      this.storage.sql.exec(
        `INSERT INTO identity_operations(
           operation_id, kind, state, payload_json, created_at, updated_at
         ) VALUES (?, 'signup', 'credential-reserved', '{}', ?, ?)`,
        input.operationId,
        input.now,
        input.now,
      );
      return { ok: true, value: { state: "credential-reserved" } };
    });
  }

  activateSignup(input: {
    operationId: string;
    opaqueKey: string;
    now: number;
  }): RpcResult<{ state: string }> {
    return this.storage.transactionSync(() => {
      const operation = this.storage.sql
        .exec<{ state: string }>(
          "SELECT state FROM identity_operations WHERE operation_id = ?",
          input.operationId,
        )
        .toArray()[0];
      if (!operation) {
        return {
          ok: false,
          error: {
            kind: "not-found",
            code: "OPERATION_NOT_FOUND",
            message: "Identity operation was not found",
          },
        };
      }
      if (operation.state === "completed") {
        return { ok: true, value: { state: "completed" } };
      }
      this.storage.sql.exec(
        "UPDATE account SET status = 'active', updated_at = ? WHERE singleton = 1",
        input.now,
      );
      this.storage.sql.exec(
        `UPDATE credential_locators
         SET state = 'active', updated_at = ? WHERE opaque_key = ?`,
        input.now,
        input.opaqueKey,
      );
      this.storage.sql.exec(
        `UPDATE identity_operations
         SET state = 'completed', updated_at = ? WHERE operation_id = ?`,
        input.now,
        input.operationId,
      );
      return { ok: true, value: { state: "completed" } };
    });
  }

  current(): CurrentAccount | null {
    const row = this.storage.sql
      .exec<{
        user_id: string;
        status: string;
        primary_email: string | null;
        auth_method: "password" | "sso" | null;
        session_epoch: number;
      }>(
        `SELECT user_id, status, primary_email, auth_method, session_epoch
         FROM account WHERE singleton = 1`,
      )
      .toArray()[0];
    if (
      row?.status !== "active" ||
      row.primary_email === null ||
      row.auth_method === null
    ) {
      return null;
    }
    return {
      userId: row.user_id,
      email: row.primary_email,
      authMethod: row.auth_method,
      trashRetentionDays: 30,
      sessionEpoch: row.session_epoch,
    };
  }

  beginDeletion(now: number): { epoch: number; locators: readonly string[] } {
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE account SET status = 'deleting',
           operation_epoch = operation_epoch + 1, session_epoch = session_epoch + 1,
           updated_at = ? WHERE singleton = 1 AND status != 'deleted'`,
        now,
      );
      const epoch = this.storage.sql
        .exec<{ operation_epoch: number }>(
          "SELECT operation_epoch FROM account WHERE singleton = 1",
        )
        .one().operation_epoch;
      const locators = this.storage.sql
        .exec<{ opaque_key: string }>(
          "SELECT opaque_key FROM credential_locators ORDER BY opaque_key",
        )
        .toArray()
        .map((row) => row.opaque_key);
      this.storage.sql.exec(
        "UPDATE credential_locators SET state = 'tombstoned', updated_at = ?",
        now,
      );
      return { epoch, locators };
    });
  }

  finishDeletion(epoch: number, now: number): boolean {
    return this.storage.transactionSync(() => {
      const cursor = this.storage.sql.exec(
        `UPDATE account SET status = 'deleted', primary_email = NULL,
           auth_method = NULL, deleted_at = ?, updated_at = ?
         WHERE singleton = 1 AND status = 'deleting' AND operation_epoch = ?`,
        now,
        now,
        epoch,
      );
      if (cursor.rowsWritten > 0) {
        this.storage.sql.exec("DELETE FROM credential_locators");
        this.storage.sql.exec("DELETE FROM identity_operations");
      }
      return cursor.rowsWritten > 0;
    });
  }

  authority(): { status: string; epoch: number } | null {
    return (
      this.storage.sql
        .exec<{ status: string; epoch: number }>(
          `SELECT status, operation_epoch AS epoch
           FROM account WHERE singleton = 1`,
        )
        .toArray()[0] ?? null
    );
  }
}
