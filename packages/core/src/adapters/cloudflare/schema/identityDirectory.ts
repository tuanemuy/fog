import { JOBS_DDL } from "./jobsDdl";
import { codeVersionOf, type MigrationStep } from "./types";

/**
 * DDL for the Identity Directory Durable Object, transcribed from
 * `spec/database/index.md`「Identity Directory DO のテーブル」.
 *
 * Version 1 creates **4 tables** — the 5 in the spec minus `_meta`, which only
 * the gate's bootstrap creates (`schema/gate.ts`).
 */
const V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS credential_mappings (
  credential_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('email','sso')),
  hmac TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved','active')),
  password_verifier TEXT,
  pending_verifier TEXT,
  change_state TEXT CHECK (
    change_state IS NULL OR change_state IN ('pending','advanced')
  ),
  change_origin TEXT CHECK (
    change_origin IS NULL OR change_origin IN ('password-change','reset')
  ),
  credential_version INTEGER NOT NULL,
  encrypted_canonical TEXT,
  encryption_generation INTEGER,
  encryption_nonce TEXT,
  failed_attempts INTEGER NOT NULL,
  next_attempt_allowed_at INTEGER,
  last_reset_requested_at INTEGER,
  operation_id TEXT,
  candidate_user_id TEXT,
  reserved_until INTEGER NOT NULL,
  saga_committed INTEGER,
  locators TEXT,
  coordinator_locator TEXT,
  caller_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, hmac)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cm_credential_id_uq
  ON credential_mappings (credential_id)`,
  `CREATE INDEX IF NOT EXISTS cm_user_idx
  ON credential_mappings (user_id)`,
  `CREATE INDEX IF NOT EXISTS cm_reservation_idx
  ON credential_mappings (status, reserved_until)
  WHERE saga_committed IS NULL`,

  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  change_auth_token TEXT,
  consumed_by_operation_id TEXT,
  token_key_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS prt_token_hash_uq
  ON password_reset_tokens (token_hash)`,
  `CREATE INDEX IF NOT EXISTS prt_credential_idx
  ON password_reset_tokens (credential_id)`,
  `CREATE INDEX IF NOT EXISTS prt_expires_idx
  ON password_reset_tokens (expires_at)`,

  ...JOBS_DDL,

  `CREATE TABLE IF NOT EXISTS rotation_checkpoints (
  rotation_kind TEXT NOT NULL CHECK (rotation_kind IN ('remap','encryption')),
  bucket_index INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  previous_count INTEGER NOT NULL,
  scanned_at INTEGER NOT NULL,
  conflict_count INTEGER NOT NULL,
  last_conflict_at INTEGER,
  last_conflict_credential_id TEXT,
  PRIMARY KEY (rotation_kind, bucket_index, generation)
)`,
];

export const IDENTITY_DIRECTORY_STEPS: readonly MigrationStep[] = [
  { version: 1, statements: V1 },
];

export const IDENTITY_DIRECTORY_CODE_VERSION = codeVersionOf(
  IDENTITY_DIRECTORY_STEPS,
);
