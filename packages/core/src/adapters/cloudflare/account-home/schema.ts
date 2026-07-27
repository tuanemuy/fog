import { type OrderedMigration, runOrderedMigrations } from "../migrations";
import type { DurableSqlStorage } from "../sql";

const V1 = [
  `CREATE TABLE IF NOT EXISTS account (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'deleting', 'deleted')),
    primary_email TEXT,
    auth_method TEXT,
    session_epoch INTEGER NOT NULL DEFAULT 0,
    operation_epoch INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS credential_locators (
    opaque_key TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('password', 'sso')),
    state TEXT NOT NULL CHECK (state IN ('reserved', 'active', 'tombstoned')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS identity_operations (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
] as const;

const V2 = [
  "ALTER TABLE credential_locators ADD COLUMN bucket INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE identity_operations ADD COLUMN operation_epoch INTEGER NOT NULL DEFAULT 0",
] as const;

export const accountHomeMigrations: readonly OrderedMigration[] = [
  { version: 1, up: V1 },
  { version: 2, up: V2 },
];

export function migrateAccountHome(
  storage: DurableSqlStorage,
  now: number,
): void {
  runOrderedMigrations(storage, now, "Account Home", accountHomeMigrations);
}
