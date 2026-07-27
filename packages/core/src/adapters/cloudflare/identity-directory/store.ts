import type {
  CredentialLocator,
  CredentialRef,
  DirectoryAuthorityRow,
  DirectoryCredential,
  OperationId,
  PasswordCredential,
} from "@repo/core/application/identity/contracts";
import {
  opaqueCredentialKey,
  operationId,
} from "@repo/core/application/identity/contracts";
import {
  Email,
  PasswordHash,
  SsoProvider,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import type { DurableSqlStorage } from "../sql";

export type ReserveCredential = Readonly<{
  locator: CredentialLocator;
  credential: CredentialRef;
  userId: UserId;
  operationId: OperationId;
  accountEpoch: number;
  now: number;
  reservationExpiresAt: number;
}>;

type MappingRow = {
  opaque_key: string;
  generation: string;
  bucket: number;
  canonical_value: string;
  kind: "password" | "sso";
  provider: string | null;
  verified_email: string | null;
  user_id: string;
  operation_id: string;
  state: "reserved" | "initialized" | "active" | "tombstoned";
  password_hash: string | null;
  account_epoch: number;
  reservation_expires_at: number | null;
};

export type RotationRow = Readonly<{
  locator: CredentialLocator;
  credential: CredentialRef;
  userId: UserId;
  operationId: OperationId;
  accountEpoch: number;
}>;

export type RotationCheckpoint = Readonly<{
  generation: string;
  bucket: number;
  cursor: string | null;
  scanned: number;
  moved: number;
  conflicts: number;
  completedAt: number | null;
}>;

export type DirectoryShardAuthorityStatus = Readonly<{
  mappings: number;
  reserved: number;
  initialized: number;
  active: number;
  tombstoned: number;
  minimumAccountEpoch: number | null;
  maximumAccountEpoch: number | null;
  restoredSessionMarker: string | null;
  restoredSessionVerifiedAt: number | null;
}>;

export class IdentityDirectoryStore {
  constructor(private readonly storage: DurableSqlStorage) {}

  reserve(input: ReserveCredential): UserId {
    return this.storage.transactionSync(() => {
      const existing = this.find(input.locator.opaqueKey);
      if (existing) {
        if (
          existing.operation_id === input.operationId &&
          existing.user_id === input.userId &&
          existing.state === "tombstoned"
        ) {
          this.validateCredential(input.credential);
          this.storage.sql.exec(
            `UPDATE credential_mappings SET canonical_value = ?, kind = ?,
               provider = ?, verified_email = ?, state = 'reserved',
               password_hash = ?, reservation_expires_at = ?,
               account_epoch = ?, updated_at = ? WHERE opaque_key = ?`,
            input.credential.canonicalValue,
            input.credential.kind,
            input.credential.kind === "sso" ? input.credential.provider : null,
            input.credential.kind === "sso"
              ? input.credential.verifiedEmail
              : null,
            input.credential.kind === "password"
              ? input.credential.passwordHash
              : null,
            input.reservationExpiresAt,
            input.accountEpoch,
            input.now,
            input.locator.opaqueKey,
          );
          return input.userId;
        }
        if (
          existing.operation_id === input.operationId &&
          existing.user_id === input.userId &&
          existing.canonical_value === input.credential.canonicalValue &&
          existing.kind === input.credential.kind
        ) {
          return UserId.create(existing.user_id);
        }
        throw new Error("CREDENTIAL_ALREADY_REGISTERED");
      }
      this.validateCredential(input.credential);
      this.storage.sql.exec(
        `INSERT INTO credential_mappings(
           opaque_key, generation, bucket, canonical_value, kind, provider,
           verified_email, user_id, operation_id, state, password_hash,
           reservation_expires_at, account_epoch, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?)`,
        input.locator.opaqueKey,
        input.locator.generation,
        input.locator.bucket,
        input.credential.canonicalValue,
        input.credential.kind,
        input.credential.kind === "sso" ? input.credential.provider : null,
        input.credential.kind === "sso" ? input.credential.verifiedEmail : null,
        input.userId,
        input.operationId,
        input.credential.kind === "password"
          ? input.credential.passwordHash
          : null,
        input.reservationExpiresAt,
        input.accountEpoch,
        input.now,
        input.now,
      );
      return input.userId;
    });
  }

  lookupPasswordSignup(opaqueOperationKey: string): {
    userId: UserId;
    email: Email;
    passwordHash: PasswordHash;
  } | null {
    const row = this.storage.sql
      .exec<{ user_id: string; email: string; password_hash: string }>(
        `SELECT user_id, email, password_hash FROM signup_operations
         WHERE opaque_operation_key = ?`,
        opaqueOperationKey,
      )
      .toArray()[0];
    return row
      ? {
          userId: UserId.create(row.user_id),
          email: Email.create(row.email),
          passwordHash: PasswordHash.create(row.password_hash),
        }
      : null;
  }

  preparePasswordSignup(input: {
    opaqueOperationKey: string;
    proposedUserId: UserId;
    email: Email;
    passwordHash: PasswordHash;
    now: number;
  }): {
    userId: UserId;
    passwordHash: PasswordHash;
    replayed: boolean;
  } {
    return this.storage.transactionSync(() => {
      const existing = this.lookupPasswordSignup(input.opaqueOperationKey);
      if (existing) {
        if (existing.email !== input.email) {
          throw new Error("IDENTITY_OPERATION_PAYLOAD_CONFLICT");
        }
        return {
          userId: existing.userId,
          passwordHash: existing.passwordHash,
          replayed: true,
        };
      }
      this.storage.sql.exec(
        `INSERT INTO signup_operations(
           opaque_operation_key, user_id, email, password_hash,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        input.opaqueOperationKey,
        input.proposedUserId,
        input.email,
        input.passwordHash,
        input.now,
        input.now,
      );
      return {
        userId: input.proposedUserId,
        passwordHash: input.passwordHash,
        replayed: false,
      };
    });
  }

  markInitialized(input: {
    locator: CredentialLocator;
    operationId: OperationId;
    userId: UserId;
    now: number;
  }): void {
    this.storage.transactionSync(() => {
      const existing = this.requireOwned(input);
      if (existing.state === "tombstoned") throw new Error("RESERVATION_LOST");
      if (existing.state === "reserved") {
        this.storage.sql.exec(
          `UPDATE credential_mappings SET state = 'initialized', updated_at = ?
           WHERE opaque_key = ?`,
          input.now,
          input.locator.opaqueKey,
        );
      }
    });
  }

  activate(input: {
    locator: CredentialLocator;
    operationId: OperationId;
    userId: UserId;
    accountEpoch: number;
    now: number;
  }): UserId {
    return this.storage.transactionSync(() => {
      const existing = this.requireOwned(input);
      if (existing.state === "tombstoned") throw new Error("RESERVATION_LOST");
      if (
        existing.state === "active" &&
        existing.account_epoch !== input.accountEpoch
      ) {
        throw new Error("ACCOUNT_EPOCH_MISMATCH");
      }
      this.storage.sql.exec(
        `UPDATE credential_mappings SET state = 'active',
           account_epoch = ?, reservation_expires_at = NULL, updated_at = ?
         WHERE opaque_key = ?`,
        input.accountEpoch,
        input.now,
        input.locator.opaqueKey,
      );
      return input.userId;
    });
  }

  lookupPassword(locator: CredentialLocator): PasswordCredential | null {
    const row = this.find(locator.opaqueKey);
    if (
      row?.state !== "active" ||
      row.kind !== "password" ||
      row.password_hash === null
    ) {
      return null;
    }
    return {
      userId: UserId.create(row.user_id),
      passwordHash: PasswordHash.create(row.password_hash),
      locator: this.toLocator(row),
      accountEpoch: row.account_epoch,
    };
  }

  lookup(locator: CredentialLocator): DirectoryCredential | null {
    const row = this.find(locator.opaqueKey);
    return row && row.state !== "tombstoned" ? this.toCredential(row) : null;
  }

  replacePassword(input: {
    operationId: OperationId;
    locator: CredentialLocator;
    userId: UserId;
    passwordHash: PasswordHash;
    accountEpoch: number;
    now: number;
  }): void {
    this.storage.transactionSync(() => {
      const row = this.find(input.locator.opaqueKey);
      if (
        !row ||
        row.user_id !== input.userId ||
        row.state !== "active" ||
        row.kind !== "password" ||
        row.account_epoch !== input.accountEpoch
      ) {
        throw new Error("ACCOUNT_AUTHORITY_MISMATCH");
      }
      this.storage.sql.exec(
        `UPDATE credential_mappings SET password_hash = ?, operation_id = ?,
           updated_at = ? WHERE opaque_key = ?`,
        input.passwordHash,
        input.operationId,
        input.now,
        input.locator.opaqueKey,
      );
    });
  }

  tombstone(input: {
    locator: CredentialLocator;
    userId: UserId;
    accountEpoch: number;
    now: number;
  }): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE credential_mappings SET state = 'tombstoned',
           password_hash = NULL, canonical_value = '', verified_email = NULL,
           account_epoch = ?, updated_at = ?
         WHERE opaque_key = ? AND user_id = ? AND account_epoch <= ?`,
        input.accountEpoch,
        input.now,
        input.locator.opaqueKey,
        input.userId,
        input.accountEpoch,
      );
    });
  }

  purge(
    locator: CredentialLocator,
    userId: UserId,
    accountEpoch: number,
  ): void {
    this.storage.transactionSync(() => {
      const mapping = this.find(locator.opaqueKey);
      this.storage.sql.exec(
        `DELETE FROM credential_mappings
         WHERE opaque_key = ? AND user_id = ?
           AND state = 'tombstoned' AND account_epoch = ?`,
        locator.opaqueKey,
        userId,
        accountEpoch,
      );
      if (mapping?.user_id === userId) {
        this.storage.sql.exec(
          "DELETE FROM reset_tokens WHERE user_id = ?",
          mapping.user_id,
        );
      }
    });
  }

  storePasswordReset(input: {
    locator: CredentialLocator;
    tokenHash: string;
    userId: UserId;
    operationId: OperationId;
    expiresAt: number;
  }): void {
    this.storage.transactionSync(() => {
      const mapping = this.find(input.locator.opaqueKey);
      if (
        mapping?.state !== "active" ||
        mapping.kind !== "password" ||
        mapping.user_id !== input.userId
      ) {
        throw new Error("ACCOUNT_AUTHORITY_MISMATCH");
      }
      const existing = this.storage.sql
        .exec<{ token_hash: string; user_id: string; expires_at: number }>(
          `SELECT token_hash, user_id, expires_at FROM reset_tokens
           WHERE operation_id = ?`,
          input.operationId,
        )
        .toArray()[0];
      if (existing) {
        if (
          existing.token_hash !== input.tokenHash ||
          existing.user_id !== input.userId ||
          existing.expires_at !== input.expiresAt
        ) {
          throw new Error("IDENTITY_OPERATION_PAYLOAD_CONFLICT");
        }
        return;
      }
      this.storage.sql.exec(
        `INSERT INTO reset_tokens(
           token_hash, user_id, operation_id, expires_at
         ) VALUES (?, ?, ?, ?)`,
        input.tokenHash,
        input.userId,
        input.operationId,
        input.expiresAt,
      );
    });
  }

  lookupPasswordReset(input: {
    operationId: OperationId;
    tokenHash: string;
    now: number;
  }): { userId: UserId } | null {
    const row = this.storage.sql
      .exec<{
        user_id: string;
        expires_at: number;
        consumed_at: number | null;
        consumed_operation_id: string | null;
      }>(
        `SELECT user_id, expires_at, consumed_at, consumed_operation_id
         FROM reset_tokens WHERE token_hash = ?`,
        input.tokenHash,
      )
      .toArray()[0];
    if (!row) return null;
    if (row.consumed_at !== null) {
      return row.consumed_operation_id === input.operationId
        ? { userId: UserId.create(row.user_id) }
        : null;
    }
    if (row.expires_at <= input.now) return null;
    return { userId: UserId.create(row.user_id) };
  }

  consumePasswordReset(input: {
    operationId: OperationId;
    tokenHash: string;
    now: number;
  }): { userId: UserId } | null {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql
        .exec<{
          user_id: string;
          expires_at: number;
          consumed_at: number | null;
          consumed_operation_id: string | null;
        }>(
          `SELECT user_id, expires_at, consumed_at, consumed_operation_id
           FROM reset_tokens WHERE token_hash = ?`,
          input.tokenHash,
        )
        .toArray()[0];
      if (!row) return null;
      if (row.consumed_at !== null) {
        return row.consumed_operation_id === input.operationId
          ? { userId: UserId.create(row.user_id) }
          : null;
      }
      if (row.expires_at <= input.now) return null;
      this.storage.sql.exec(
        `UPDATE reset_tokens SET consumed_at = ?, consumed_operation_id = ?
         WHERE token_hash = ? AND consumed_at IS NULL`,
        input.now,
        input.operationId,
        input.tokenHash,
      );
      return { userId: UserId.create(row.user_id) };
    });
  }

  scanForAuthorityReconcile(input: {
    generation: string;
    bucket: number;
    cursor?: string;
    limit: number;
  }): {
    rows: readonly DirectoryAuthorityRow[];
    nextCursor: string | null;
  } {
    const rows = this.storage.sql
      .exec<MappingRow>(
        `SELECT opaque_key, generation, bucket, canonical_value, kind, provider,
                verified_email, user_id, operation_id, state, password_hash,
                account_epoch, reservation_expires_at
         FROM credential_mappings
         WHERE generation = ? AND bucket = ? AND opaque_key > ?
         ORDER BY opaque_key LIMIT ?`,
        input.generation,
        input.bucket,
        input.cursor ?? "",
        input.limit + 1,
      )
      .toArray();
    const page = rows.slice(0, input.limit);
    return {
      rows: page.map((row) => ({
        locator: this.toLocator(row),
        userId: UserId.create(row.user_id),
        operationId: operationId(row.operation_id),
        state: row.state,
        accountEpoch: row.account_epoch,
      })),
      nextCursor:
        rows.length > input.limit ? (page.at(-1)?.opaque_key ?? null) : null,
    };
  }

  scanForRotation(input: {
    generation: string;
    cursor?: string;
    limit: number;
  }): { rows: readonly RotationRow[]; nextCursor: string | null } {
    const rows = this.storage.sql
      .exec<MappingRow>(
        `SELECT opaque_key, generation, bucket, canonical_value, kind, provider,
                verified_email, user_id, operation_id, state, password_hash,
                account_epoch, reservation_expires_at
         FROM credential_mappings
         WHERE generation = ? AND opaque_key > ? AND state = 'active'
         ORDER BY opaque_key LIMIT ?`,
        input.generation,
        input.cursor ?? "",
        input.limit + 1,
      )
      .toArray();
    const page = rows.slice(0, input.limit);
    return {
      rows: page.map((row) => ({
        locator: this.toLocator(row),
        credential: this.toCredential(row).credential,
        userId: UserId.create(row.user_id),
        operationId: operationId(row.operation_id),
        accountEpoch: row.account_epoch,
      })),
      nextCursor:
        rows.length > input.limit ? (page.at(-1)?.opaque_key ?? null) : null,
    };
  }

  saveRotationCheckpoint(input: {
    generation: string;
    bucket: number;
    cursor: string | null;
    scanned: number;
    moved: number;
    conflicts: number;
    completedAt: number | null;
  }): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `INSERT INTO rotation_checkpoints(
           generation, bucket, cursor_key, scanned_count, moved_count,
           conflict_count, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(generation, bucket) DO UPDATE SET
           cursor_key = excluded.cursor_key,
           scanned_count = rotation_checkpoints.scanned_count + excluded.scanned_count,
           moved_count = rotation_checkpoints.moved_count + excluded.moved_count,
           conflict_count = rotation_checkpoints.conflict_count + excluded.conflict_count,
           completed_at = excluded.completed_at`,
        input.generation,
        input.bucket,
        input.cursor,
        input.scanned,
        input.moved,
        input.conflicts,
        input.completedAt,
      );
    });
  }

  rotationCheckpoint(
    generation: string,
    bucket: number,
  ): RotationCheckpoint | null {
    const row = this.storage.sql
      .exec<{
        generation: string;
        bucket: number;
        cursor_key: string | null;
        scanned_count: number;
        moved_count: number;
        conflict_count: number;
        completed_at: number | null;
      }>(
        `SELECT generation, bucket, cursor_key, scanned_count, moved_count,
                conflict_count, completed_at
         FROM rotation_checkpoints
         WHERE generation = ? AND bucket = ?`,
        generation,
        bucket,
      )
      .toArray()[0];
    return row
      ? {
          generation: row.generation,
          bucket: row.bucket,
          cursor: row.cursor_key,
          scanned: row.scanned_count,
          moved: row.moved_count,
          conflicts: row.conflict_count,
          completedAt: row.completed_at,
        }
      : null;
  }

  markRestoredSession(marker: string, now: number): void {
    if (
      marker.length === 0 ||
      new TextEncoder().encode(marker).byteLength > 256
    ) {
      throw new Error("RESTORE_MARKER_INVALID");
    }
    this.storage.sql.exec(
      `INSERT INTO restore_verification(singleton, marker, verified_at)
       VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         marker = excluded.marker, verified_at = excluded.verified_at`,
      marker,
      now,
    );
  }

  authorityStatus(): DirectoryShardAuthorityStatus {
    const counts = this.storage.sql
      .exec<{
        mappings: number;
        reserved: number;
        initialized: number;
        active: number;
        tombstoned: number;
        minimum_epoch: number | null;
        maximum_epoch: number | null;
      }>(
        `SELECT
           COUNT(*) AS mappings,
           COALESCE(SUM(CASE WHEN state = 'reserved' THEN 1 ELSE 0 END), 0)
             AS reserved,
           COALESCE(SUM(CASE WHEN state = 'initialized' THEN 1 ELSE 0 END), 0)
             AS initialized,
           COALESCE(SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END), 0)
             AS active,
           COALESCE(SUM(CASE WHEN state = 'tombstoned' THEN 1 ELSE 0 END), 0)
             AS tombstoned,
           MIN(account_epoch) AS minimum_epoch,
           MAX(account_epoch) AS maximum_epoch
         FROM credential_mappings`,
      )
      .one();
    const marker = this.storage.sql
      .exec<{ marker: string; verified_at: number }>(
        "SELECT marker, verified_at FROM restore_verification WHERE singleton = 1",
      )
      .toArray()[0];
    return {
      mappings: counts.mappings,
      reserved: counts.reserved,
      initialized: counts.initialized,
      active: counts.active,
      tombstoned: counts.tombstoned,
      minimumAccountEpoch: counts.minimum_epoch,
      maximumAccountEpoch: counts.maximum_epoch,
      restoredSessionMarker: marker?.marker ?? null,
      restoredSessionVerifiedAt: marker?.verified_at ?? null,
    };
  }

  expiredReservations(now: number, limit: number): readonly RotationRow[] {
    return this.storage.sql
      .exec<MappingRow>(
        `SELECT opaque_key, generation, bucket, canonical_value, kind, provider,
                verified_email, user_id, operation_id, state, password_hash,
                account_epoch, reservation_expires_at
         FROM credential_mappings
         WHERE state IN ('reserved', 'initialized')
           AND reservation_expires_at <= ?
         ORDER BY reservation_expires_at, opaque_key LIMIT ?`,
        now,
        limit,
      )
      .toArray()
      .map((row) => ({
        locator: this.toLocator(row),
        credential: this.toCredential(row).credential,
        userId: UserId.create(row.user_id),
        operationId: operationId(row.operation_id),
        accountEpoch: row.account_epoch,
      }));
  }

  private requireOwned(input: {
    locator: CredentialLocator;
    operationId: OperationId;
    userId: UserId;
  }): MappingRow {
    const existing = this.find(input.locator.opaqueKey);
    if (
      !existing ||
      existing.operation_id !== input.operationId ||
      existing.user_id !== input.userId
    ) {
      throw new Error("RESERVATION_LOST");
    }
    return existing;
  }

  private find(opaqueKey: string): MappingRow | null {
    return (
      this.storage.sql
        .exec<MappingRow>(
          `SELECT opaque_key, generation, bucket, canonical_value, kind, provider,
                  verified_email, user_id, operation_id, state, password_hash,
                  account_epoch, reservation_expires_at
           FROM credential_mappings WHERE opaque_key = ?`,
          opaqueKey,
        )
        .toArray()[0] ?? null
    );
  }

  private validateCredential(credential: CredentialRef): void {
    if (
      credential.kind === "password" &&
      credential.passwordHash.length === 0
    ) {
      throw new Error("PASSWORD_HASH_REQUIRED");
    }
    if (
      credential.kind === "sso" &&
      (credential.provider.length === 0 ||
        credential.verifiedEmail.length === 0)
    ) {
      throw new Error("SSO_PROVIDER_AND_EMAIL_REQUIRED");
    }
  }

  private toLocator(row: MappingRow): CredentialLocator {
    return {
      opaqueKey: opaqueCredentialKey(row.opaque_key),
      generation: row.generation,
      bucket: row.bucket,
    };
  }

  private toCredential(row: MappingRow): DirectoryCredential {
    const credential: CredentialRef =
      row.kind === "password"
        ? {
            kind: "password",
            canonicalValue: row.canonical_value,
            passwordHash: PasswordHash.create(row.password_hash ?? ""),
          }
        : {
            kind: "sso",
            canonicalValue: row.canonical_value,
            provider: SsoProvider.create(row.provider ?? ""),
            verifiedEmail: Email.create(row.verified_email ?? ""),
          };
    return {
      userId: UserId.create(row.user_id),
      operationId: operationId(row.operation_id),
      locator: this.toLocator(row),
      state: row.state,
      accountEpoch: row.account_epoch,
      credential,
    };
  }
}
