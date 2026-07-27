import type {
  CredentialKind,
  IdentityOperation,
  IdentityOperationKind,
  IdentityOperationState,
  LogicalCredential,
  OperationId,
} from "@repo/core/application/identity/contracts";
import { operationId } from "@repo/core/application/identity/contracts";
import {
  opaqueCredentialKey,
  type PhysicalCredentialLocator,
} from "../identityPhysical";
import {
  Email,
  PasswordHash,
  SsoProvider,
  SsoSubject,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import type { DurableSqlStorage } from "../sql";

type OperationRow = {
  operation_id: string;
  kind: IdentityOperationKind;
  state: IdentityOperationState;
  payload_json: string;
  operation_epoch: number;
};

export type PhysicalAccountAuthSummary = Readonly<{
  userId: UserId;
  status: "pending" | "active" | "deleting" | "deleted";
  primaryEmail: Email | null;
  authMethods: readonly CredentialKind[];
  credentials: readonly (LogicalCredential &
    Readonly<{ locators: readonly PhysicalCredentialLocator[] }>)[];
  sessionEpoch: number;
  operationEpoch: number;
}>;

const ALLOWED_TRANSITIONS: Readonly<
  Partial<Record<IdentityOperationKind, ReadonlySet<string>>>
> = {
  signup: new Set([
    "pending>credential-reserved",
    "credential-reserved>user-data-initialized",
    "user-data-initialized>directory-active",
    "directory-active>completed",
    "pending>compensating",
    "credential-reserved>compensating",
    "compensating>failed",
  ]),
  "sso-create": new Set([
    "pending>credential-reserved",
    "credential-reserved>user-data-initialized",
    "user-data-initialized>directory-active",
    "directory-active>completed",
    "pending>compensating",
    "credential-reserved>compensating",
    "compensating>failed",
  ]),
  "sso-link": new Set([
    "pending>credential-reserved",
    "credential-reserved>user-data-initialized",
    "user-data-initialized>directory-active",
    "directory-active>completed",
  ]),
  "sso-unlink": new Set([
    "pending>credential-reserved",
    "credential-reserved>directory-active",
    "directory-active>completed",
  ]),
  "password-reset": new Set([
    "pending>credential-reserved",
    "credential-reserved>directory-active",
    "directory-active>completed",
  ]),
  "password-change": new Set([
    "pending>credential-reserved",
    "credential-reserved>directory-active",
    "directory-active>completed",
  ]),
};

export class AccountHomeStore {
  constructor(private readonly storage: DurableSqlStorage) {}

  beginOperation(input: {
    operationId: OperationId;
    userId: UserId;
    kind: IdentityOperationKind;
    payloadDigest: string;
    primaryEmail?: Email;
    now: number;
  }): IdentityOperation {
    return this.storage.transactionSync(() => {
      const existingOperation = this.operation(input.operationId);
      if (existingOperation) {
        if (
          existingOperation.kind !== input.kind ||
          existingOperation.payloadDigest !== input.payloadDigest
        ) {
          throw new Error("IDENTITY_OPERATION_PAYLOAD_CONFLICT");
        }
        return existingOperation;
      }
      const account = this.storage.sql
        .exec<{ user_id: string; status: string; operation_epoch: number }>(
          `SELECT user_id, status, operation_epoch
           FROM account WHERE singleton = 1`,
        )
        .toArray()[0];
      if (account && account.user_id !== input.userId) {
        throw new Error("ACCOUNT_OWNER_MISMATCH");
      }
      if (account?.status === "deleted") {
        throw new Error("ACCOUNT_DELETED");
      }
      if (account?.status === "active" && input.kind === "signup") {
        throw new Error("ACCOUNT_ALREADY_ACTIVE");
      }
      if (input.kind === "password-reset") {
        const inProgress = this.storage.sql
          .exec<{ operation_id: string }>(
            `SELECT operation_id FROM identity_operations
             WHERE kind = 'password-reset' AND state != 'completed'
             LIMIT 1`,
          )
          .toArray()[0];
        if (inProgress) throw new Error("PASSWORD_RESET_IN_PROGRESS");
      }
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO account(
           singleton, user_id, status, primary_email, auth_method,
           created_at, updated_at
         ) VALUES (1, ?, 'pending', ?, NULL, ?, ?)`,
        input.userId,
        input.primaryEmail ?? null,
        input.now,
        input.now,
      );
      const epoch = account?.operation_epoch ?? 0;
      this.storage.sql.exec(
        `INSERT INTO identity_operations(
           operation_id, kind, state, payload_json, operation_epoch,
           created_at, updated_at
         ) VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
        input.operationId,
        input.kind,
        JSON.stringify({ digest: input.payloadDigest }),
        epoch,
        input.now,
        input.now,
      );
      return {
        operationId: input.operationId,
        kind: input.kind,
        state: "pending",
        payloadDigest: input.payloadDigest,
        epoch,
      };
    });
  }

  advanceOperation(input: {
    operationId: OperationId;
    userId: UserId;
    expectedState: IdentityOperationState;
    nextState: IdentityOperationState;
    locator?: PhysicalCredentialLocator;
    credential?: LogicalCredential;
    primaryEmail?: Email;
    bumpSessionEpoch?: boolean;
    now: number;
  }): IdentityOperation {
    return this.storage.transactionSync(() => {
      const current = this.operation(input.operationId);
      if (!current) throw new Error("OPERATION_NOT_FOUND");
      if (current.state !== input.expectedState) {
        if (
          current.state === input.nextState ||
          current.state === "completed"
        ) {
          return current;
        }
        throw new Error("IDENTITY_OPERATION_PHASE_CONFLICT");
      }
      if (
        !ALLOWED_TRANSITIONS[current.kind]?.has(
          `${input.expectedState}>${input.nextState}`,
        )
      ) {
        throw new Error("IDENTITY_OPERATION_TRANSITION_INVALID");
      }
      if (input.locator && input.credential) {
        this.upsertLocator(
          input.locator,
          input.credential,
          input.nextState === "completed" ? "active" : "reserved",
          input.now,
        );
      }
      this.storage.sql.exec(
        `UPDATE identity_operations SET state = ?, updated_at = ?
         WHERE operation_id = ? AND state = ?`,
        input.nextState,
        input.now,
        input.operationId,
        input.expectedState,
      );
      if (input.nextState === "completed") {
        if (input.credential) {
          this.storage.sql.exec(
            `UPDATE credential_locators
             SET kind = ?, credential_json = ?, updated_at = ?
             WHERE logical_credential_id = ?`,
            input.credential.kind,
            JSON.stringify(input.credential),
            input.now,
            input.credential.credentialId,
          );
        }
        this.storage.sql.exec(
          `UPDATE account SET status = 'active',
             primary_email = COALESCE(?, primary_email),
             auth_method = COALESCE(auth_method, ?),
             session_epoch = session_epoch + ?,
             updated_at = ?
           WHERE singleton = 1 AND user_id = ?`,
          input.primaryEmail ?? null,
          input.credential?.kind ?? null,
          input.bumpSessionEpoch ? 1 : 0,
          input.now,
          input.userId,
        );
        this.storage.sql.exec(
          `UPDATE credential_locators SET state = 'active', updated_at = ?
           WHERE state = 'reserved'
             AND (? IS NULL OR logical_credential_id = ?)`,
          input.now,
          input.credential?.credentialId ?? null,
          input.credential?.credentialId ?? null,
        );
      }
      return this.operation(input.operationId) as IdentityOperation;
    });
  }

  getOperation(operation: OperationId): IdentityOperation | null {
    return this.operation(operation);
  }

  compensateCreate(input: {
    operationId: OperationId;
    userId: UserId;
    now: number;
  }): void {
    this.storage.transactionSync(() => {
      const current = this.operation(input.operationId);
      if (!current) return;
      if (!["signup", "sso-create"].includes(current.kind)) {
        throw new Error("IDENTITY_OPERATION_PAYLOAD_CONFLICT");
      }
      if (current.state === "failed") return;
      if (
        !["pending", "credential-reserved", "compensating"].includes(
          current.state,
        )
      ) {
        throw new Error("IDENTITY_OPERATION_COMPENSATION_FORBIDDEN");
      }
      this.storage.sql.exec(
        `UPDATE identity_operations SET state = 'compensating', updated_at = ?
         WHERE operation_id = ? AND state IN ('pending', 'credential-reserved')`,
        input.now,
        input.operationId,
      );
      this.storage.sql.exec("DELETE FROM credential_locators");
      this.storage.sql.exec(
        `UPDATE account SET status = 'deleted', primary_email = NULL,
           auth_method = NULL, deleted_at = ?, updated_at = ?
         WHERE singleton = 1 AND user_id = ? AND status = 'pending'`,
        input.now,
        input.now,
        input.userId,
      );
      this.storage.sql.exec(
        `UPDATE identity_operations SET state = 'failed',
           payload_json = '{"digest":"compensated"}', updated_at = ?
         WHERE operation_id = ? AND state = 'compensating'`,
        input.now,
        input.operationId,
      );
    });
  }

  addCredentialLocator(input: {
    operationId: OperationId;
    userId: UserId;
    locator: PhysicalCredentialLocator;
    credential: LogicalCredential;
    primaryEmail?: Email;
    bumpSessionEpoch: boolean;
    now: number;
  }): PhysicalAccountAuthSummary {
    return this.storage.transactionSync(() => {
      const existing = this.storage.sql
        .exec<{ state: string; kind: IdentityOperationKind }>(
          `SELECT state, kind FROM identity_operations
           WHERE operation_id = ?`,
          input.operationId,
        )
        .toArray()[0];
      if (
        existing &&
        !["signup", "sso-create", "sso-link"].includes(existing.kind)
      ) {
        throw new Error("IDENTITY_OPERATION_PAYLOAD_CONFLICT");
      }
      this.upsertLocator(
        input.locator,
        input.credential,
        existing?.state === "completed" ||
          (!existing && this.accountStatus() === "active")
          ? "active"
          : "reserved",
        input.now,
      );
      if (!existing) {
        const epoch = this.operationEpoch();
        this.storage.sql.exec(
          `INSERT INTO identity_operations(
             operation_id, kind, state, payload_json, operation_epoch,
             created_at, updated_at
           ) VALUES (?, 'sso-link', 'completed', '{"digest":"primitive"}', ?, ?, ?)`,
          input.operationId,
          epoch,
          input.now,
          input.now,
        );
        this.storage.sql.exec(
          `UPDATE account SET primary_email = COALESCE(?, primary_email),
             auth_method = CASE
               WHEN auth_method IS NULL THEN ?
               WHEN auth_method = ? THEN auth_method
               ELSE 'sso'
             END,
             session_epoch = session_epoch + ?, updated_at = ?
           WHERE singleton = 1 AND user_id = ? AND status != 'deleted'`,
          input.primaryEmail ?? null,
          input.credential.kind,
          input.credential.kind,
          input.bumpSessionEpoch ? 1 : 0,
          input.now,
          input.userId,
        );
      }
      const summary = this.authSummary();
      if (!summary) throw new Error("ACCOUNT_NOT_FOUND");
      return summary;
    });
  }

  removeCredentialLocator(input: {
    operationId: OperationId;
    userId: UserId;
    credentialId: string;
    bumpSessionEpoch: boolean;
    now: number;
  }): PhysicalAccountAuthSummary {
    return this.storage.transactionSync(() => {
      const activeCredentialCount = this.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(DISTINCT logical_credential_id) AS count
           FROM credential_locators WHERE state = 'active'`,
        )
        .one().count;
      const target = this.storage.sql
        .exec<{ state: string; kind: CredentialKind }>(
          `SELECT state, kind FROM credential_locators
           WHERE logical_credential_id = ? LIMIT 1`,
          input.credentialId,
        )
        .toArray()[0];
      if (target?.state === "active" && activeCredentialCount <= 1) {
        throw new Error("LAST_CREDENTIAL_UNLINK_FORBIDDEN");
      }
      const existing = this.storage.sql
        .exec<{ operation_id: string; kind: IdentityOperationKind }>(
          `SELECT operation_id, kind FROM identity_operations
           WHERE operation_id = ?`,
          input.operationId,
        )
        .toArray()[0];
      if (existing && existing.kind !== "sso-unlink") {
        throw new Error("IDENTITY_OPERATION_PAYLOAD_CONFLICT");
      }
      this.storage.sql.exec(
        `UPDATE credential_locators SET state = 'tombstoned', updated_at = ?
         WHERE logical_credential_id = ?`,
        input.now,
        input.credentialId,
      );
      if (!existing) {
        this.storage.sql.exec(
          `INSERT INTO identity_operations(
             operation_id, kind, state, payload_json, operation_epoch,
             created_at, updated_at
           ) VALUES (?, 'sso-unlink', 'completed', '{"digest":"primitive"}', ?, ?, ?)`,
          input.operationId,
          this.operationEpoch(),
          input.now,
          input.now,
        );
        this.storage.sql.exec(
          `UPDATE account SET session_epoch = session_epoch + ?, updated_at = ?
           WHERE singleton = 1 AND user_id = ?`,
          input.bumpSessionEpoch ? 1 : 0,
          input.now,
          input.userId,
        );
      } else {
        const operation = this.operation(input.operationId);
        if (operation?.state === "directory-active") {
          this.storage.sql.exec(
            `UPDATE identity_operations SET state = 'completed', updated_at = ?
             WHERE operation_id = ? AND state = 'directory-active'`,
            input.now,
            input.operationId,
          );
          this.storage.sql.exec(
            `UPDATE account SET session_epoch = session_epoch + ?,
               updated_at = ?
             WHERE singleton = 1 AND user_id = ?`,
            input.bumpSessionEpoch ? 1 : 0,
            input.now,
            input.userId,
          );
        }
      }
      const summary = this.authSummary();
      if (!summary) throw new Error("ACCOUNT_NOT_FOUND");
      return summary;
    });
  }

  replaceCredentialLocator(input: {
    operationId: OperationId;
    userId: UserId;
    previous: PhysicalCredentialLocator;
    active: PhysicalCredentialLocator;
    kind: CredentialKind;
    now: number;
  }): void {
    this.storage.transactionSync(() => {
      const account = this.authSummary();
      if (
        !account ||
        account.userId !== input.userId ||
        account.status !== "active"
      ) {
        throw new Error("ACCOUNT_AUTHORITY_MISMATCH");
      }
      const previousCredential = this.storage.sql
        .exec<{ logical_credential_id: string }>(
          `SELECT logical_credential_id FROM credential_locators
           WHERE opaque_key = ?`,
          input.previous.opaqueKey,
        )
        .toArray()[0];
      this.upsertLocator(
        input.active,
        this.logicalCredential(
          previousCredential?.logical_credential_id ?? input.previous.opaqueKey,
        ),
        "active",
        input.now,
      );
      this.storage.sql.exec(
        `UPDATE credential_locators SET state = 'tombstoned', updated_at = ?
         WHERE opaque_key = ?`,
        input.now,
        input.previous.opaqueKey,
      );
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO identity_operations(
           operation_id, kind, state, payload_json, operation_epoch,
           created_at, updated_at
         ) VALUES (?, 'credential-rotation', 'completed',
           '{"digest":"rotation"}', ?, ?, ?)`,
        input.operationId,
        account.operationEpoch,
        input.now,
        input.now,
      );
    });
  }

  countActiveGeneration(generation: string): number {
    return this.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM credential_locators
         WHERE state = 'active' AND generation = ?`,
        generation,
      )
      .one().count;
  }

  beginDeletion(input: {
    operationId: OperationId;
    userId: UserId;
    now: number;
  }): {
    epoch: number;
    state: IdentityOperationState;
    locators: readonly PhysicalCredentialLocator[];
  } {
    return this.storage.transactionSync(() => {
      const existing = this.operation(input.operationId);
      if (existing) {
        if (existing.kind !== "delete-account") {
          throw new Error("IDENTITY_OPERATION_PAYLOAD_CONFLICT");
        }
        return {
          epoch: existing.epoch,
          state: existing.state,
          locators: this.locators(),
        };
      }
      this.storage.sql.exec(
        `UPDATE account SET status = 'deleting',
           operation_epoch = operation_epoch + 1,
           session_epoch = session_epoch + 1, updated_at = ?
         WHERE singleton = 1 AND user_id = ? AND status != 'deleted'`,
        input.now,
        input.userId,
      );
      const epoch = this.operationEpoch();
      this.storage.sql.exec(
        `INSERT INTO identity_operations(
           operation_id, kind, state, payload_json, operation_epoch,
           created_at, updated_at
         ) VALUES (?, 'delete-account', 'tombstoning',
           '{"digest":"delete-account"}', ?, ?, ?)`,
        input.operationId,
        epoch,
        input.now,
        input.now,
      );
      this.storage.sql.exec(
        "UPDATE credential_locators SET state = 'tombstoned', updated_at = ?",
        input.now,
      );
      return { epoch, state: "tombstoning", locators: this.locators() };
    });
  }

  finishDeletion(input: {
    operationId: OperationId;
    userId: UserId;
    epoch: number;
    now: number;
  }): boolean {
    return this.storage.transactionSync(() => {
      const cursor = this.storage.sql.exec(
        `UPDATE account SET status = 'deleted', primary_email = NULL,
           auth_method = NULL, deleted_at = ?, updated_at = ?
         WHERE singleton = 1 AND user_id = ? AND status = 'deleting'
           AND operation_epoch = ?`,
        input.now,
        input.now,
        input.userId,
        input.epoch,
      );
      this.storage.sql.exec(
        `UPDATE identity_operations SET state = 'completed',
           payload_json = '{"digest":"deleted"}', updated_at = ?
         WHERE operation_id = ? AND operation_epoch = ?`,
        input.now,
        input.operationId,
        input.epoch,
      );
      this.storage.sql.exec("DELETE FROM credential_locators");
      this.storage.sql.exec(
        "DELETE FROM identity_operations WHERE operation_id != ?",
        input.operationId,
      );
      return cursor.rowsWritten > 0 || this.accountStatus() === "deleted";
    });
  }

  authSummary(): PhysicalAccountAuthSummary | null {
    const row = this.storage.sql
      .exec<{
        user_id: string;
        status: PhysicalAccountAuthSummary["status"];
        primary_email: string | null;
        session_epoch: number;
        operation_epoch: number;
      }>(
        `SELECT user_id, status, primary_email, session_epoch, operation_epoch
         FROM account WHERE singleton = 1`,
      )
      .toArray()[0];
    if (!row) return null;
    const credentialRows = this.storage.sql
      .exec<{
        logical_credential_id: string;
        kind: CredentialKind;
        opaque_key: string;
        generation: string;
        bucket: number;
        credential_json: string | null;
      }>(
        `SELECT logical_credential_id, kind, opaque_key, generation, bucket,
                credential_json
         FROM credential_locators
         WHERE state = 'active'
         ORDER BY logical_credential_id, generation, bucket, opaque_key`,
      )
      .toArray();
    const credentials = [
      ...new Set(credentialRows.map((row) => row.logical_credential_id)),
    ].map((credentialId) => {
      const rows = credentialRows.filter(
        (row) => row.logical_credential_id === credentialId,
      );
      const credential = this.parseCredential(
        credentialId,
        rows[0]?.kind ?? "password",
        rows[0]?.credential_json ?? null,
        row.primary_email,
      );
      return {
        ...credential,
        locators: rows.map((row) => ({
          opaqueKey: opaqueCredentialKey(row.opaque_key),
          generation: row.generation,
          bucket: row.bucket,
        })),
      };
    });
    const activeKinds = [...new Set(credentials.map((item) => item.kind))];
    return {
      userId: UserId.create(row.user_id),
      status: row.status,
      primaryEmail:
        row.primary_email === null ? null : Email.create(row.primary_email),
      authMethods: activeKinds,
      credentials,
      sessionEpoch: row.session_epoch,
      operationEpoch: row.operation_epoch,
    };
  }

  private operation(id: OperationId): IdentityOperation | null {
    const row = this.storage.sql
      .exec<OperationRow>(
        `SELECT operation_id, kind, state, payload_json, operation_epoch
         FROM identity_operations WHERE operation_id = ?`,
        id,
      )
      .toArray()[0];
    if (!row) return null;
    const payload = JSON.parse(row.payload_json) as { digest?: unknown };
    if (typeof payload.digest !== "string") {
      throw new Error("IDENTITY_OPERATION_PAYLOAD_CORRUPT");
    }
    return {
      operationId: operationId(row.operation_id),
      kind: row.kind,
      state: row.state,
      payloadDigest: payload.digest,
      epoch: row.operation_epoch,
    };
  }

  private logicalCredential(credentialId: string): LogicalCredential {
    const row = this.storage.sql
      .exec<{ kind: CredentialKind; credential_json: string | null }>(
        `SELECT kind, credential_json FROM credential_locators
         WHERE logical_credential_id = ? LIMIT 1`,
        credentialId,
      )
      .toArray()[0];
    if (!row) throw new Error("ACCOUNT_CREDENTIAL_NOT_FOUND");
    const primaryEmail = this.storage.sql
      .exec<{ primary_email: string | null }>(
        "SELECT primary_email FROM account WHERE singleton = 1",
      )
      .toArray()[0]?.primary_email;
    return this.parseCredential(
      credentialId,
      row.kind,
      row.credential_json,
      primaryEmail ?? null,
    );
  }

  private parseCredential(
    credentialId: string,
    kind: CredentialKind,
    serialized: string | null,
    fallbackEmail: string | null,
  ): LogicalCredential {
    if (serialized) {
      const value = JSON.parse(serialized) as Record<string, unknown>;
      if (value.kind === "password") {
        return {
          credentialId,
          kind: "password",
          email: Email.create(String(value.email)),
          passwordHash: PasswordHash.create(String(value.passwordHash)),
        };
      }
      if (value.kind === "sso") {
        return {
          credentialId,
          kind: "sso",
          provider: SsoProvider.create(String(value.provider)),
          subject: SsoSubject.create(String(value.subject)),
          verifiedEmail: Email.create(String(value.verifiedEmail)),
        };
      }
    }
    const email = Email.create(fallbackEmail ?? "legacy@example.invalid");
    return kind === "password"
      ? {
          credentialId,
          kind,
          email,
          passwordHash: PasswordHash.create("legacy-unavailable"),
        }
      : {
          credentialId,
          kind,
          provider: SsoProvider.create("legacy"),
          subject: SsoSubject.create(credentialId),
          verifiedEmail: email,
        };
  }

  private upsertLocator(
    locator: PhysicalCredentialLocator,
    credential: LogicalCredential,
    state: "reserved" | "active" | "tombstoned",
    now: number,
  ): void {
    this.storage.sql.exec(
      `INSERT INTO credential_locators(
         opaque_key, generation, bucket, logical_credential_id, kind, state,
         credential_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(opaque_key) DO UPDATE SET
         generation = excluded.generation, bucket = excluded.bucket,
         logical_credential_id = excluded.logical_credential_id,
         kind = excluded.kind, state = excluded.state,
         credential_json = excluded.credential_json,
         updated_at = excluded.updated_at`,
      locator.opaqueKey,
      locator.generation,
      locator.bucket,
      credential.credentialId,
      credential.kind,
      state,
      JSON.stringify(credential),
      now,
      now,
    );
  }

  private locators(
    state?: "reserved" | "active" | "tombstoned",
  ): readonly PhysicalCredentialLocator[] {
    return this.storage.sql
      .exec<{ opaque_key: string; generation: string; bucket: number }>(
        `SELECT opaque_key, generation, bucket FROM credential_locators
         ${state ? "WHERE state = ?" : ""}
         ORDER BY generation, bucket, opaque_key`,
        ...(state ? [state] : []),
      )
      .toArray()
      .map((row) => ({
        opaqueKey: opaqueCredentialKey(row.opaque_key),
        generation: row.generation,
        bucket: row.bucket,
      }));
  }

  private accountStatus(): PhysicalAccountAuthSummary["status"] | null {
    return (
      this.storage.sql
        .exec<{ status: PhysicalAccountAuthSummary["status"] }>(
          "SELECT status FROM account WHERE singleton = 1",
        )
        .toArray()[0]?.status ?? null
    );
  }

  private operationEpoch(): number {
    return this.storage.sql
      .exec<{ operation_epoch: number }>(
        "SELECT operation_epoch FROM account WHERE singleton = 1",
      )
      .one().operation_epoch;
  }
}
