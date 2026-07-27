import type { DurableSqlStorage } from "../sql";

const VERSION = 1;

const statements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`,
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
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
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

export function migrateAccountHome(
  storage: DurableSqlStorage,
  now: number,
): void {
  storage.transactionSync(() => {
    storage.sql.exec(statements[0]);
    const current = storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .one().version;
    if (current > VERSION) {
      throw new Error(`Unsupported Account Home schema version: ${current}`);
    }
    if (current === VERSION) return;
    for (const statement of statements.slice(1)) storage.sql.exec(statement);
    storage.sql.exec(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      VERSION,
      now,
    );
  });
}
