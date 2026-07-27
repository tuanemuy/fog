import { type OrderedMigration, runOrderedMigrations } from "../migrations";
import type { DurableSqlStorage } from "../sql";

const V1 = [
  `CREATE TABLE IF NOT EXISTS credential_mappings (
    opaque_key TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    canonical_value TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('password', 'sso')),
    provider TEXT,
    user_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('reserved', 'initialized', 'active', 'tombstoned')
    ),
    password_hash TEXT,
    reservation_expires_at INTEGER,
    account_epoch INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      state = 'tombstoned'
      OR
      (kind = 'password' AND password_hash IS NOT NULL AND provider IS NULL)
      OR
      (kind = 'sso' AND password_hash IS NULL AND provider IS NOT NULL
       )
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS credential_operation_uq
   ON credential_mappings(operation_id, opaque_key)`,
  `CREATE INDEX IF NOT EXISTS credential_rotation_scan_idx
   ON credential_mappings(generation, opaque_key)`,
  `CREATE INDEX IF NOT EXISTS credential_reservation_expiry_idx
   ON credential_mappings(state, reservation_expires_at)`,
  `CREATE TABLE IF NOT EXISTS reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS rotation_checkpoints (
    generation TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    cursor_key TEXT,
    scanned_count INTEGER NOT NULL DEFAULT 0,
    moved_count INTEGER NOT NULL DEFAULT 0,
    conflict_count INTEGER NOT NULL DEFAULT 0,
    completed_at INTEGER,
    PRIMARY KEY (generation, bucket)
  )`,
] as const;

const V2 = [
  "ALTER TABLE credential_mappings ADD COLUMN verified_email TEXT",
  "ALTER TABLE credential_mappings ADD COLUMN bucket INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE reset_tokens ADD COLUMN consumed_operation_id TEXT",
  `CREATE INDEX IF NOT EXISTS credential_rotation_scan_idx
   ON credential_mappings(generation, opaque_key)`,
  `CREATE INDEX IF NOT EXISTS credential_reservation_expiry_idx
   ON credential_mappings(state, reservation_expires_at)`,
] as const;

const V3 = [
  `CREATE TABLE IF NOT EXISTS signup_operations (
    opaque_operation_key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
] as const;

const V4 = [
  `CREATE TABLE IF NOT EXISTS restore_verification (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    marker TEXT NOT NULL,
    verified_at INTEGER NOT NULL
  )`,
] as const;

const V5 = [
  "ALTER TABLE signup_operations ADD COLUMN prepared_at INTEGER NOT NULL DEFAULT 0",
  "UPDATE signup_operations SET prepared_at = created_at WHERE prepared_at = 0",
] as const;

const V6 = [
  `CREATE TABLE IF NOT EXISTS rotation_checkpoint_mutations (
    operation_id TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0
  )`,
] as const;

const V7 = [
  `CREATE TABLE IF NOT EXISTS directory_reconcile_jobs (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    phase TEXT NOT NULL CHECK (phase IN ('pending', 'running')),
    attempt INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER NOT NULL,
    last_error_code TEXT,
    updated_at INTEGER NOT NULL
  )`,
] as const;

const V8 = [
  `CREATE TABLE IF NOT EXISTS identity_mail_jobs (
    operation_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    provider_idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'completed', 'poison')),
    attempt INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS identity_mail_jobs_due_idx
   ON identity_mail_jobs(state, next_run_at)`,
] as const;

const V9 = [
  `CREATE TABLE IF NOT EXISTS sso_create_operations (
    opaque_operation_key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
] as const;

export const identityDirectoryMigrations: readonly OrderedMigration[] = [
  { version: 1, up: V1 },
  { version: 2, up: V2 },
  { version: 3, up: V3 },
  { version: 4, up: V4 },
  { version: 5, up: V5 },
  { version: 6, up: V6 },
  { version: 7, up: V7 },
  { version: 8, up: V8 },
  { version: 9, up: V9 },
];

export function migrateIdentityDirectory(
  storage: DurableSqlStorage,
  now: number,
): void {
  runOrderedMigrations(
    storage,
    now,
    "Identity Directory",
    identityDirectoryMigrations,
  );
}
