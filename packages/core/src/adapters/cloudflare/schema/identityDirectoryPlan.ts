import {
  applyAsyncWorkTables,
  applyMetaTable,
  type MigrationPlan,
} from "./plan";

/** v1 of an Identity Directory bucket: the seven tables of `spec/database/index.md`. */
export function applyIdentityDirectorySchemaV1(sql: SqlStorage): void {
  applyMetaTable(sql);
  applyAsyncWorkTables(sql);

  sql.exec(`CREATE TABLE IF NOT EXISTS credential_mappings (
    credential_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('email','sso')),
    hmac TEXT NOT NULL,
    generation INTEGER NOT NULL,
    user_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('reserved','active')),
    password_verifier TEXT,
    pending_verifier TEXT,
    change_state TEXT CHECK (change_state IS NULL OR change_state IN ('pending','advanced')),
    change_origin TEXT CHECK (change_origin IS NULL OR change_origin IN ('password-change','reset')),
    credential_version INTEGER NOT NULL,
    encrypted_canonical TEXT NOT NULL,
    encryption_generation INTEGER NOT NULL,
    encryption_nonce TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL,
    next_attempt_allowed_at INTEGER,
    operation_id TEXT,
    candidate_user_id TEXT,
    reserved_until INTEGER NOT NULL,
    saga_committed INTEGER,
    locators TEXT,
    coordinator_locator TEXT,
    caller_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (kind, hmac)
  )`);
  sql.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS cm_credential_id_uq ON credential_mappings (credential_id)",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS cm_user_idx ON credential_mappings (user_id)",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS cm_reservation_idx ON credential_mappings (status, reserved_until) WHERE saga_committed IS NULL",
  );

  sql.exec(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    change_auth_token TEXT,
    consumed_by_operation_id TEXT,
    token_key_generation INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  sql.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS prt_token_hash_uq ON password_reset_tokens (token_hash)",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS prt_credential_idx ON password_reset_tokens (credential_id)",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS prt_expires_idx ON password_reset_tokens (expires_at)",
  );

  sql.exec(`CREATE TABLE IF NOT EXISTS reset_request_windows (
    window_key TEXT PRIMARY KEY,
    key_generation INTEGER NOT NULL,
    first_requested_at INTEGER NOT NULL,
    last_requested_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS rrw_expires_idx ON reset_request_windows (expires_at)",
  );

  sql.exec(`CREATE TABLE IF NOT EXISTS rotation_checkpoints (
    rotation_kind TEXT NOT NULL CHECK (rotation_kind IN ('remap','encryption')),
    bucket_index INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    previous_count INTEGER NOT NULL,
    scanned_at INTEGER NOT NULL,
    conflict_count INTEGER NOT NULL,
    last_conflict_at INTEGER,
    last_conflict_credential_id TEXT,
    PRIMARY KEY (rotation_kind, bucket_index, generation)
  )`);
}

export const IDENTITY_DIRECTORY_TABLE_NAMES = [
  "_meta",
  "jobs",
  "outbox_events",
  "credential_mappings",
  "password_reset_tokens",
  "reset_request_windows",
  "rotation_checkpoints",
] as const;

export const IDENTITY_DIRECTORY_INDEX_NAMES = [
  "jobs_runnable_idx",
  "jobs_lease_idx",
  "jobs_completed_idx",
  "outbox_runnable_idx",
  "outbox_lease_idx",
  "outbox_completed_idx",
  "cm_credential_id_uq",
  "cm_user_idx",
  "cm_reservation_idx",
  "prt_token_hash_uq",
  "prt_credential_idx",
  "prt_expires_idx",
  "rrw_expires_idx",
] as const;

/** Neither `reindex` nor `migrate-bulk` belongs to this class, so no seed is declarable. */
export const IDENTITY_DIRECTORY_PLAN: MigrationPlan<never> = {
  targetVersion: 1,
  steps: [{ version: 1, apply: applyIdentityDirectorySchemaV1 }],
};
