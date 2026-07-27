import type { OperationId } from "@repo/core/application/identity/contracts";
import { operationId } from "@repo/core/application/identity/contracts";
import type {
  PhysicalCredentialLocator,
  StoredCredentialRef,
  StoredDirectoryCredential,
} from "../identityPhysical";
import { opaqueCredentialKey } from "../identityPhysical";
import { PasswordHash, UserId } from "@repo/core/domain/identity/valueObject";
import type { DurableSqlStorage } from "../sql";

export type ReserveCredential = Readonly<{
  locator: PhysicalCredentialLocator;
  credential: StoredCredentialRef;
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
  logical_credential_id: string;
  canonical_value: string;
  kind: "password" | "sso";
  provider: string | null;
  verified_email: string | null;
  subject_encrypted: string | null;
  user_id: string;
  operation_id: string;
  state: "reserved" | "initialized" | "active" | "tombstoned";
  password_hash: string | null;
  account_epoch: number;
  reservation_expires_at: number | null;
};

export type RotationRow = Readonly<{
  locator: PhysicalCredentialLocator;
  credential: StoredCredentialRef;
  userId: UserId;
  operationId: OperationId;
  accountEpoch: number;
}>;

export type PhysicalDirectoryAuthorityRow = Readonly<{
  locator: PhysicalCredentialLocator;
  userId: UserId;
  operationId: OperationId;
  state: MappingRow["state"];
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

export type DirectoryReconcileJob = Readonly<{
  attempt: number;
  nextRunAt: number;
}>;

export type IdentityMailJob = Readonly<{
  operationId: OperationId;
  deliveryPayloadEncrypted: string;
  providerIdempotencyKey: string;
  ownerToken: string;
  attempt: number;
}>;

export class IdentityDirectoryStore {
  private static readonly OPERATION_REPLAY_TTL_MS = 24 * 60 * 60_000;

  constructor(private readonly storage: DurableSqlStorage) {}

  reserve(input: ReserveCredential): UserId {
    return this.storage.transactionSync(() => {
      const existing = this.find(input.locator.opaqueKey);
      if (existing) {
        if (
          input.operationId.startsWith("rotate:") &&
          existing.state === "active" &&
          existing.user_id === input.userId &&
          existing.account_epoch === input.accountEpoch &&
          this.sameCredential(existing, input.credential)
        ) {
          this.storage.sql.exec(
            `UPDATE credential_mappings SET operation_id = ?,
               canonical_value = ?, verified_email = ?, subject_encrypted = ?,
               updated_at = ?
             WHERE opaque_key = ?`,
            input.operationId,
            input.credential.canonicalValueEncrypted,
            input.credential.kind === "sso"
              ? input.credential.verifiedEmailEncrypted
              : input.credential.emailEncrypted,
            input.credential.kind === "sso"
              ? input.credential.subjectEncrypted
              : null,
            input.now,
            input.locator.opaqueKey,
          );
          return input.userId;
        }
        if (
          existing.operation_id === input.operationId &&
          existing.user_id === input.userId &&
          existing.state === "tombstoned"
        ) {
          this.validateCredential(input.credential);
          this.storage.sql.exec(
            `UPDATE credential_mappings SET logical_credential_id = ?,
               canonical_value = ?, kind = ?, provider = ?,
               verified_email = ?, subject_encrypted = ?, state = 'reserved',
               password_hash = ?, reservation_expires_at = ?,
               account_epoch = ?, updated_at = ? WHERE opaque_key = ?`,
            input.credential.credentialId,
            input.credential.canonicalValueEncrypted,
            input.credential.kind,
            input.credential.kind === "sso" ? input.credential.provider : null,
            input.credential.kind === "sso"
              ? input.credential.verifiedEmailEncrypted
              : input.credential.emailEncrypted,
            input.credential.kind === "sso"
              ? input.credential.subjectEncrypted
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
          this.sameCredential(existing, input.credential)
        ) {
          return UserId.create(existing.user_id);
        }
        if (
          (existing.state === "reserved" || existing.state === "initialized") &&
          input.operationId.localeCompare(existing.operation_id) < 0
        ) {
          this.validateCredential(input.credential);
          this.storage.sql.exec(
            `UPDATE credential_mappings SET generation = ?, bucket = ?,
               logical_credential_id = ?, canonical_value = ?, kind = ?,
               provider = ?, verified_email = ?, subject_encrypted = ?,
               user_id = ?, operation_id = ?, state = 'reserved',
               password_hash = ?, reservation_expires_at = ?,
               account_epoch = ?, updated_at = ? WHERE opaque_key = ?`,
            input.locator.generation,
            input.locator.bucket,
            input.credential.credentialId,
            input.credential.canonicalValueEncrypted,
            input.credential.kind,
            input.credential.kind === "sso" ? input.credential.provider : null,
            input.credential.kind === "sso"
              ? input.credential.verifiedEmailEncrypted
              : input.credential.emailEncrypted,
            input.credential.kind === "sso"
              ? input.credential.subjectEncrypted
              : null,
            input.userId,
            input.operationId,
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
        throw new Error("CREDENTIAL_ALREADY_REGISTERED");
      }
      this.validateCredential(input.credential);
      this.storage.sql.exec(
        `INSERT INTO credential_mappings(
           opaque_key, generation, bucket, logical_credential_id,
           canonical_value, kind, provider, verified_email, subject_encrypted,
           user_id, operation_id, state, password_hash,
           reservation_expires_at, account_epoch, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?)`,
        input.locator.opaqueKey,
        input.locator.generation,
        input.locator.bucket,
        input.credential.credentialId,
        input.credential.canonicalValueEncrypted,
        input.credential.kind,
        input.credential.kind === "sso" ? input.credential.provider : null,
        input.credential.kind === "sso"
          ? input.credential.verifiedEmailEncrypted
          : input.credential.emailEncrypted,
        input.credential.kind === "sso"
          ? input.credential.subjectEncrypted
          : null,
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
    emailEncrypted: string;
    passwordHash: PasswordHash;
    preparedAt: number;
  } | null {
    const row = this.storage.sql
      .exec<{
        user_id: string;
        email: string;
        password_hash: string;
        prepared_at: number;
      }>(
        `SELECT user_id, email, password_hash, prepared_at FROM signup_operations
         WHERE opaque_operation_key = ?`,
        opaqueOperationKey,
      )
      .toArray()[0];
    return row
      ? {
          userId: UserId.create(row.user_id),
          emailEncrypted: row.email,
          passwordHash: PasswordHash.create(row.password_hash),
          preparedAt: row.prepared_at,
        }
      : null;
  }

  preparePasswordSignup(input: {
    opaqueOperationKey: string;
    proposedUserId: UserId;
    emailEncrypted: string;
    passwordHash: PasswordHash;
    now: number;
  }): {
    userId: UserId;
    passwordHash: PasswordHash;
    preparedAt: number;
    replayed: boolean;
  } {
    return this.storage.transactionSync(() => {
      const existing = this.lookupPasswordSignup(input.opaqueOperationKey);
      if (existing) {
        if (existing.emailEncrypted !== input.emailEncrypted) {
          throw new Error("IDENTITY_OPERATION_PAYLOAD_CONFLICT");
        }
        return {
          userId: existing.userId,
          passwordHash: existing.passwordHash,
          preparedAt: existing.preparedAt,
          replayed: true,
        };
      }
      this.storage.sql.exec(
        `INSERT INTO signup_operations(
           opaque_operation_key, user_id, email, password_hash,
           prepared_at, created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.opaqueOperationKey,
        input.proposedUserId,
        input.emailEncrypted,
        input.passwordHash,
        input.now,
        input.now,
        input.now,
        input.now + IdentityDirectoryStore.OPERATION_REPLAY_TTL_MS,
      );
      return {
        userId: input.proposedUserId,
        passwordHash: input.passwordHash,
        preparedAt: input.now,
        replayed: false,
      };
    });
  }

  prepareSsoCreate(input: {
    opaqueOperationKey: string;
    proposedUserId: UserId;
    provider: string;
    subjectEncrypted: string;
    emailEncrypted: string;
    now: number;
  }): { userId: UserId; replayed: boolean } {
    return this.storage.transactionSync(() => {
      const existing = this.storage.sql
        .exec<{
          user_id: string;
          provider: string;
          subject: string;
          email: string;
        }>(
          `SELECT user_id, provider, subject, email
           FROM sso_create_operations WHERE opaque_operation_key = ?`,
          input.opaqueOperationKey,
        )
        .toArray()[0];
      if (existing) {
        if (
          existing.provider !== input.provider ||
          existing.subject !== input.subjectEncrypted ||
          existing.email !== input.emailEncrypted
        ) {
          throw new Error("IDENTITY_OPERATION_PAYLOAD_CONFLICT");
        }
        return { userId: UserId.create(existing.user_id), replayed: true };
      }
      this.storage.sql.exec(
        `INSERT INTO sso_create_operations(
           opaque_operation_key, user_id, provider, subject, email,
           created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.opaqueOperationKey,
        input.proposedUserId,
        input.provider,
        input.subjectEncrypted,
        input.emailEncrypted,
        input.now,
        input.now,
        input.now + IdentityDirectoryStore.OPERATION_REPLAY_TTL_MS,
      );
      return { userId: input.proposedUserId, replayed: false };
    });
  }

  purgeExpiredOperationRegistries(now: number): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "DELETE FROM signup_operations WHERE expires_at > 0 AND expires_at <= ?",
        now,
      );
      this.storage.sql.exec(
        "DELETE FROM sso_create_operations WHERE expires_at > 0 AND expires_at <= ?",
        now,
      );
    });
  }

  markInitialized(input: {
    locator: PhysicalCredentialLocator;
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
    locator: PhysicalCredentialLocator;
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

  lookupPassword(
    locator: PhysicalCredentialLocator,
  ): StoredDirectoryCredential | null {
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
      locator: this.toLocator(row),
      operationId: operationId(row.operation_id),
      state: row.state,
      accountEpoch: row.account_epoch,
      credential: this.toStoredCredential(row),
    };
  }

  lookup(locator: PhysicalCredentialLocator): StoredDirectoryCredential | null {
    const row = this.find(locator.opaqueKey);
    return row && row.state !== "tombstoned" ? this.toCredential(row) : null;
  }

  replacePassword(input: {
    operationId: OperationId;
    locator: PhysicalCredentialLocator;
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
    locator: PhysicalCredentialLocator;
    userId: UserId;
    accountEpoch: number;
    now: number;
  }): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE credential_mappings SET state = 'tombstoned',
           password_hash = NULL, canonical_value = '', verified_email = NULL,
           subject_encrypted = NULL,
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
    locator: PhysicalCredentialLocator,
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
    locator: PhysicalCredentialLocator;
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

  enqueuePasswordResetMail(input: {
    operationId: OperationId;
    userId: UserId;
    emailEncrypted: string;
    deliveryPayloadEncrypted: string;
    providerIdempotencyKey: string;
    now: number;
  }): void {
    this.storage.transactionSync(() => {
      const existing = this.storage.sql
        .exec<{
          user_id: string;
          email: string;
          delivery_payload_encrypted: string | null;
          provider_idempotency_key: string;
        }>(
          `SELECT user_id, email, delivery_payload_encrypted,
                  provider_idempotency_key
           FROM identity_mail_jobs WHERE operation_id = ?`,
          input.operationId,
        )
        .toArray()[0];
      if (existing) {
        if (
          existing.user_id !== input.userId ||
          existing.provider_idempotency_key !== input.providerIdempotencyKey
        ) {
          throw new Error("IDENTITY_OPERATION_PAYLOAD_CONFLICT");
        }
        return;
      }
      this.storage.sql.exec(
        `INSERT INTO identity_mail_jobs(
           operation_id, user_id, email, token_hash,
           provider_idempotency_key, state, next_run_at,
           delivery_payload_encrypted, created_at, updated_at
         ) VALUES (?, ?, ?, '', ?, 'pending', ?, ?, ?, ?)`,
        input.operationId,
        input.userId,
        input.emailEncrypted,
        input.providerIdempotencyKey,
        input.now,
        input.deliveryPayloadEncrypted,
        input.now,
        input.now,
      );
    });
  }

  claimIdentityMail(
    now: number,
    ownerToken: string,
    leaseMs = 30_000,
  ): IdentityMailJob | null {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql
        .exec<{
          operation_id: string;
          delivery_payload_encrypted: string | null;
          provider_idempotency_key: string;
          attempt: number;
        }>(
          `SELECT operation_id, delivery_payload_encrypted,
                  provider_idempotency_key, attempt
           FROM identity_mail_jobs
           WHERE (
             (state = 'pending' AND next_run_at <= ?)
             OR (state = 'leased' AND lease_until <= ?)
           )
           ORDER BY next_run_at, operation_id LIMIT 1`,
          now,
          now,
        )
        .toArray()[0];
      if (!row?.delivery_payload_encrypted) return null;
      const cursor = this.storage.sql.exec(
        `UPDATE identity_mail_jobs
         SET state = 'leased', owner_token = ?, lease_until = ?,
             attempt = attempt + 1, updated_at = ?
         WHERE operation_id = ?
           AND (
             (state = 'pending' AND next_run_at <= ?)
             OR (state = 'leased' AND lease_until <= ?)
           )`,
        ownerToken,
        now + leaseMs,
        now,
        row.operation_id,
        now,
        now,
      );
      if (cursor.rowsWritten === 0) return null;
      return {
        operationId: operationId(row.operation_id),
        deliveryPayloadEncrypted: row.delivery_payload_encrypted,
        providerIdempotencyKey: row.provider_idempotency_key,
        ownerToken,
        attempt: row.attempt + 1,
      };
    });
  }

  completeIdentityMail(
    operation: OperationId,
    ownerToken: string,
    now: number,
  ): boolean {
    return (
      this.storage.sql.exec(
        `UPDATE identity_mail_jobs
         SET state = 'completed', owner_token = NULL, lease_until = NULL,
             updated_at = ?
         WHERE operation_id = ? AND state = 'leased' AND owner_token = ?`,
        now,
        operation,
        ownerToken,
      ).rowsWritten > 0
    );
  }

  failIdentityMail(input: {
    operationId: OperationId;
    ownerToken: string;
    errorCode: string;
    retryable: boolean;
    now: number;
  }): number | null {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql
        .exec<{ attempt: number }>(
          `SELECT attempt FROM identity_mail_jobs
           WHERE operation_id = ? AND state = 'leased' AND owner_token = ?`,
          input.operationId,
          input.ownerToken,
        )
        .toArray()[0];
      if (!row) return this.nextIdentityMailRun();
      const poison = !input.retryable || row.attempt >= 5;
      const nextRunAt =
        input.now + Math.min(15 * 60_000, 1_000 * 2 ** row.attempt);
      this.storage.sql.exec(
        `UPDATE identity_mail_jobs
         SET state = ?, next_run_at = ?, owner_token = NULL,
             lease_until = NULL, last_error_code = ?, poison_reason = ?,
             updated_at = ?
         WHERE operation_id = ? AND owner_token = ?`,
        poison ? "poison" : "pending",
        nextRunAt,
        input.errorCode.slice(0, 128),
        poison ? input.errorCode.slice(0, 128) : null,
        input.now,
        input.operationId,
        input.ownerToken,
      );
      return this.nextIdentityMailRun();
    });
  }

  nextIdentityMailRun(): number | null {
    const row = this.storage.sql
      .exec<{ next_run_at: number | null }>(
        `SELECT MIN(
           CASE WHEN state = 'leased' THEN lease_until ELSE next_run_at END
         ) AS next_run_at
         FROM identity_mail_jobs WHERE state IN ('pending', 'leased')`,
      )
      .one();
    return row.next_run_at;
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
    rows: readonly PhysicalDirectoryAuthorityRow[];
    nextCursor: string | null;
  } {
    const rows = this.storage.sql
      .exec<MappingRow>(
        `SELECT opaque_key, generation, bucket, logical_credential_id,
                canonical_value, kind, provider, verified_email,
                subject_encrypted, user_id, operation_id, state, password_hash,
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
        `SELECT opaque_key, generation, bucket, logical_credential_id,
                canonical_value, kind, provider, verified_email,
                subject_encrypted, user_id, operation_id, state, password_hash,
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
    operationId: OperationId;
    generation: string;
    bucket: number;
    cursor: string | null;
    scanned: number;
    moved: number;
    conflicts: number;
    completedAt: number | null;
  }): void {
    this.storage.transactionSync(() => {
      const payload = JSON.stringify({
        generation: input.generation,
        bucket: input.bucket,
        cursor: input.cursor,
        scanned: input.scanned,
        moved: input.moved,
        conflicts: input.conflicts,
        completedAt: input.completedAt,
      });
      const existing = this.storage.sql
        .exec<{ payload_json: string }>(
          `SELECT payload_json FROM rotation_checkpoint_mutations
           WHERE operation_id = ?`,
          input.operationId,
        )
        .toArray()[0];
      if (existing) {
        if (existing.payload_json !== payload) {
          throw new Error("IDENTITY_OPERATION_PAYLOAD_CONFLICT");
        }
        return;
      }
      this.storage.sql.exec(
        `INSERT INTO rotation_checkpoint_mutations(
           operation_id, generation, bucket, payload_json
         ) VALUES (?, ?, ?, ?)`,
        input.operationId,
        input.generation,
        input.bucket,
        payload,
      );
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
        `SELECT cm.opaque_key, cm.generation, cm.bucket,
                cm.logical_credential_id, cm.canonical_value, cm.kind,
                cm.provider, cm.verified_email, cm.subject_encrypted,
                cm.user_id, cm.operation_id, cm.state, cm.password_hash,
                cm.account_epoch, cm.reservation_expires_at
         FROM credential_mappings cm
         LEFT JOIN directory_reconcile_failures
           ON directory_reconcile_failures.operation_id =
              cm.operation_id
         WHERE cm.state IN ('reserved', 'initialized')
           AND cm.reservation_expires_at <= ?
           AND directory_reconcile_failures.poison_reason IS NULL
           AND (
             directory_reconcile_failures.operation_id IS NULL
             OR directory_reconcile_failures.next_run_at <= ?
           )
         ORDER BY cm.reservation_expires_at, cm.opaque_key LIMIT ?`,
        now,
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

  enqueueReconcile(nextRunAt: number, now: number): void {
    this.storage.sql.exec(
      `INSERT INTO directory_reconcile_jobs(
         singleton, phase, attempt, next_run_at, last_error_code, updated_at
       ) VALUES (1, 'pending', 0, ?, NULL, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         phase = 'pending',
         next_run_at = MIN(directory_reconcile_jobs.next_run_at, excluded.next_run_at),
         updated_at = excluded.updated_at`,
      nextRunAt,
      now,
    );
  }

  claimReconcile(now: number): DirectoryReconcileJob | null {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql
        .exec<{ attempt: number; next_run_at: number }>(
          `SELECT attempt, next_run_at FROM directory_reconcile_jobs
           WHERE singleton = 1 AND next_run_at <= ?`,
          now,
        )
        .toArray()[0];
      if (!row) return null;
      this.storage.sql.exec(
        `UPDATE directory_reconcile_jobs SET phase = 'running',
           attempt = attempt + 1, updated_at = ? WHERE singleton = 1`,
        now,
      );
      return { attempt: row.attempt + 1, nextRunAt: row.next_run_at };
    });
  }

  finishReconcile(now: number): number | null {
    return this.storage.transactionSync(() => {
      const next = this.storage.sql
        .exec<{ next_run_at: number | null }>(
          `SELECT MIN(
             CASE
               WHEN directory_reconcile_failures.next_run_at IS NULL
                 THEN credential_mappings.reservation_expires_at
               WHEN directory_reconcile_failures.next_run_at >
                    credential_mappings.reservation_expires_at
                 THEN directory_reconcile_failures.next_run_at
               ELSE credential_mappings.reservation_expires_at
             END
           ) AS next_run_at
           FROM credential_mappings
           LEFT JOIN directory_reconcile_failures
             ON directory_reconcile_failures.operation_id =
                credential_mappings.operation_id
           WHERE credential_mappings.state IN ('reserved', 'initialized')
             AND credential_mappings.reservation_expires_at IS NOT NULL
             AND directory_reconcile_failures.poison_reason IS NULL`,
        )
        .one().next_run_at;
      if (next === null) {
        this.storage.sql.exec(
          "DELETE FROM directory_reconcile_jobs WHERE singleton = 1",
        );
        return null;
      }
      this.storage.sql.exec(
        `UPDATE directory_reconcile_jobs SET phase = 'pending', attempt = 0,
           next_run_at = ?, last_error_code = NULL, updated_at = ?
         WHERE singleton = 1`,
        Math.max(next, now),
        now,
      );
      return Math.max(next, now);
    });
  }

  failReconcile(errorCode: string, now: number): number {
    const job = this.storage.sql
      .exec<{ attempt: number }>(
        "SELECT attempt FROM directory_reconcile_jobs WHERE singleton = 1",
      )
      .one();
    const nextRunAt = now + Math.min(60_000, 1_000 * 2 ** job.attempt);
    this.storage.sql.exec(
      `UPDATE directory_reconcile_jobs SET phase = 'pending',
         next_run_at = ?, last_error_code = ?, updated_at = ?
       WHERE singleton = 1`,
      nextRunAt,
      errorCode.slice(0, 128),
      now,
    );
    return nextRunAt;
  }

  clearReconcileFailure(operation: OperationId): void {
    this.storage.sql.exec(
      "DELETE FROM directory_reconcile_failures WHERE operation_id = ?",
      operation,
    );
  }

  failReconcileOperation(
    operation: OperationId,
    errorCode: string,
    now: number,
  ): number | null {
    return this.storage.transactionSync(() => {
      const current =
        this.storage.sql
          .exec<{ attempt: number }>(
            `SELECT attempt FROM directory_reconcile_failures
             WHERE operation_id = ?`,
            operation,
          )
          .toArray()[0]?.attempt ?? 0;
      const attempt = current + 1;
      const poison = attempt >= 5;
      const nextRunAt = now + Math.min(15 * 60_000, 1_000 * 2 ** attempt);
      this.storage.sql.exec(
        `INSERT INTO directory_reconcile_failures(
           operation_id, attempt, next_run_at, last_error_code,
           poison_reason, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(operation_id) DO UPDATE SET
           attempt = excluded.attempt,
           next_run_at = excluded.next_run_at,
           last_error_code = excluded.last_error_code,
           poison_reason = excluded.poison_reason,
           updated_at = excluded.updated_at`,
        operation,
        attempt,
        nextRunAt,
        errorCode.slice(0, 128),
        poison ? errorCode.slice(0, 128) : null,
        now,
      );
      return poison ? null : nextRunAt;
    });
  }

  private requireOwned(input: {
    locator: PhysicalCredentialLocator;
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
                  logical_credential_id, verified_email, subject_encrypted,
                  user_id, operation_id, state, password_hash,
                  account_epoch, reservation_expires_at
           FROM credential_mappings WHERE opaque_key = ?`,
          opaqueKey,
        )
        .toArray()[0] ?? null
    );
  }

  private validateCredential(credential: StoredCredentialRef): void {
    if (
      credential.kind === "password" &&
      credential.passwordHash.length === 0
    ) {
      throw new Error("PASSWORD_HASH_REQUIRED");
    }
    if (
      credential.kind === "sso" &&
      (credential.provider.length === 0 ||
        credential.subjectEncrypted.length === 0 ||
        credential.verifiedEmailEncrypted.length === 0)
    ) {
      throw new Error("SSO_PROVIDER_AND_EMAIL_REQUIRED");
    }
  }

  private sameCredential(
    row: MappingRow,
    credential: StoredCredentialRef,
  ): boolean {
    if (
      row.kind !== credential.kind ||
      row.logical_credential_id !== credential.credentialId
    ) {
      return false;
    }
    return credential.kind === "password"
      ? row.password_hash === credential.passwordHash
      : row.provider === credential.provider;
  }

  private toLocator(row: MappingRow): PhysicalCredentialLocator {
    return {
      opaqueKey: opaqueCredentialKey(row.opaque_key),
      generation: row.generation,
      bucket: row.bucket,
    };
  }

  private toStoredCredential(row: MappingRow): StoredCredentialRef {
    return row.kind === "password"
      ? {
          credentialId: row.logical_credential_id,
          kind: "password",
          canonicalValueEncrypted: row.canonical_value,
          emailEncrypted: row.verified_email ?? "",
          passwordHash: PasswordHash.create(row.password_hash ?? ""),
        }
      : {
          credentialId: row.logical_credential_id,
          kind: "sso",
          canonicalValueEncrypted: row.canonical_value,
          provider: row.provider ?? "",
          subjectEncrypted: row.subject_encrypted ?? "",
          verifiedEmailEncrypted: row.verified_email ?? "",
        };
  }

  private toCredential(row: MappingRow): StoredDirectoryCredential {
    const credential = this.toStoredCredential(row);
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
