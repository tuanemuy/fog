import type {
  PasswordCredential,
  RpcResult,
} from "@repo/core/application/identity/contracts";
import type { PasswordHash } from "@repo/core/domain/identity/valueObject";
import type { DurableSqlStorage } from "../sql";

export type ReserveCredential = Readonly<{
  opaqueKey: string;
  generation: string;
  canonicalValue: string;
  kind: "password" | "sso";
  provider?: string;
  userId: string;
  operationId: string;
  passwordHash?: PasswordHash;
  now: number;
  reservationExpiresAt: number;
}>;

type MappingRow = {
  opaque_key: string;
  generation: string;
  canonical_value: string;
  kind: "password" | "sso";
  provider: string | null;
  user_id: string;
  operation_id: string;
  state: "reserved" | "initialized" | "active" | "tombstoned";
  password_hash: string | null;
  account_epoch: number;
};

export class IdentityDirectoryStore {
  constructor(private readonly storage: DurableSqlStorage) {}

  reserve(input: ReserveCredential): RpcResult<{ userId: string }> {
    return this.storage.transactionSync(() => {
      const existing = this.find(input.opaqueKey);
      if (existing) {
        if (
          existing.operation_id === input.operationId &&
          existing.user_id === input.userId
        ) {
          return { ok: true, value: { userId: existing.user_id } };
        }
        return {
          ok: false,
          error: {
            kind: "conflict",
            code: "CREDENTIAL_ALREADY_REGISTERED",
            message: "Credential is already registered",
          },
        };
      }
      this.storage.sql.exec(
        `INSERT INTO credential_mappings(
           opaque_key, generation, canonical_value, kind, provider, user_id,
           operation_id, state, password_hash, reservation_expires_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
        input.opaqueKey,
        input.generation,
        input.canonicalValue,
        input.kind,
        input.provider ?? null,
        input.userId,
        input.operationId,
        input.passwordHash ?? null,
        input.reservationExpiresAt,
        input.now,
        input.now,
      );
      return { ok: true, value: { userId: input.userId } };
    });
  }

  activate(input: {
    opaqueKey: string;
    operationId: string;
    userId: string;
    now: number;
  }): RpcResult<{ userId: string }> {
    return this.storage.transactionSync(() => {
      const existing = this.find(input.opaqueKey);
      if (
        !existing ||
        existing.operation_id !== input.operationId ||
        existing.user_id !== input.userId ||
        existing.state === "tombstoned"
      ) {
        return {
          ok: false,
          error: {
            kind: "conflict",
            code: "RESERVATION_LOST",
            message: "Credential reservation is no longer owned",
          },
        };
      }
      this.storage.sql.exec(
        `UPDATE credential_mappings
         SET state = 'active', reservation_expires_at = NULL, updated_at = ?
         WHERE opaque_key = ?`,
        input.now,
        input.opaqueKey,
      );
      return { ok: true, value: { userId: input.userId } };
    });
  }

  lookupPassword(opaqueKey: string): PasswordCredential | null {
    const row = this.find(opaqueKey);
    if (
      row?.state !== "active" ||
      row.kind !== "password" ||
      row.password_hash === null
    ) {
      return null;
    }
    return {
      userId: row.user_id,
      passwordHash: row.password_hash as PasswordHash,
    };
  }

  lookup(opaqueKey: string): MappingRow | null {
    const row = this.find(opaqueKey);
    return row?.state === "active" ? row : null;
  }

  tombstone(input: {
    opaqueKey: string;
    accountEpoch: number;
    now: number;
  }): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE credential_mappings
         SET state = 'tombstoned', password_hash = NULL,
           canonical_value = '', account_epoch = ?, updated_at = ?
         WHERE opaque_key = ? AND account_epoch < ?`,
        input.accountEpoch,
        input.now,
        input.opaqueKey,
        input.accountEpoch,
      );
    });
  }

  purge(opaqueKey: string, accountEpoch: number): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `DELETE FROM credential_mappings
         WHERE opaque_key = ? AND state = 'tombstoned' AND account_epoch = ?`,
        opaqueKey,
        accountEpoch,
      );
    });
  }

  reclaimExpired(now: number): number {
    return this.storage.transactionSync(() => {
      const cursor = this.storage.sql.exec(
        `DELETE FROM credential_mappings
         WHERE state = 'reserved' AND reservation_expires_at <= ?`,
        now,
      );
      return cursor.rowsWritten;
    });
  }

  storePasswordReset(input: {
    tokenHash: string;
    userId: string;
    operationId: string;
    expiresAt: number;
  }): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `INSERT INTO reset_tokens(
           token_hash, user_id, operation_id, expires_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(operation_id) DO NOTHING`,
        input.tokenHash,
        input.userId,
        input.operationId,
        input.expiresAt,
      );
    });
  }

  consumePasswordReset(
    tokenHash: string,
    now: number,
  ): { userId: string } | null {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql
        .exec<{ user_id: string }>(
          `SELECT user_id FROM reset_tokens
           WHERE token_hash = ? AND expires_at > ? AND consumed_at IS NULL`,
          tokenHash,
          now,
        )
        .toArray()[0];
      if (!row) return null;
      this.storage.sql.exec(
        `UPDATE reset_tokens SET consumed_at = ?
         WHERE token_hash = ? AND consumed_at IS NULL`,
        now,
        tokenHash,
      );
      return { userId: row.user_id };
    });
  }

  private find(opaqueKey: string): MappingRow | null {
    return (
      this.storage.sql
        .exec<MappingRow>(
          `SELECT opaque_key, generation, canonical_value, kind, provider,
                  user_id, operation_id, state, password_hash, account_epoch
           FROM credential_mappings WHERE opaque_key = ?`,
          opaqueKey,
        )
        .toArray()[0] ?? null
    );
  }
}
